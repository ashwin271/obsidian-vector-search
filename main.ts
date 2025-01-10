import { 
    App, 
    Editor, 
    MarkdownView, 
    Modal, 
    Notice, 
    Plugin, 
    PluginSettingTab, 
    Setting,
    TFile
} from 'obsidian';

interface MyPluginSettings {
    ollamaURL: string;
    searchThreshold: number;
    maxResults: number;
    chunkSize: number;
    debounceTime: number;
    modelName: string;
}

const DEFAULT_SETTINGS: MyPluginSettings = {
    ollamaURL: 'http://localhost:11434',
    searchThreshold: 0.8,
    maxResults: 10,
    chunkSize: 500,
    debounceTime: 300,
    modelName: 'nomic-embed-text'
}

const MINIMUM_OBSIDIAN_VERSION = '0.15.0';

export default class VectorSearchPlugin extends Plugin {
    settings: MyPluginSettings;
    vectorStore: Map<string, number[]> = new Map();

    async onload() {
        if (this.compareVersions(this.app.version, MINIMUM_OBSIDIAN_VERSION) < 0) {
            new Notice(`Vector Search requires Obsidian ${MINIMUM_OBSIDIAN_VERSION} or higher`);
            return;
        }

        await this.loadSettings();
        await this.checkOllamaConnection();

        // Add a ribbon icon for rebuilding the vector index
        this.addRibbonIcon('refresh-cw', 'Rebuild Vector Index', async () => {
            await this.buildVectorIndex();
            new Notice('Vector index rebuilt!');
        });

        // Add a command to open search modal
        this.addCommand({
            id: 'search-similar-notes',
            name: 'Search Similar Notes',
            callback: () => {
                new SearchModal(this.app, this).open();
            }
        });

        // Add settings tab
        this.addSettingTab(new VectorSearchSettingTab(this.app, this));
    }

    async onunload() {
        // Clean up resources if needed
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    private compareVersions(a: string, b: string): number {
        const pa = a.split('.');
        const pb = b.split('.');
        for (let i = 0; i < 3; i++) {
            const na = Number(pa[i]);
            const nb = Number(pb[i]);
            if (na > nb) return 1;
            if (nb > na) return -1;
            if (!isNaN(na) && isNaN(nb)) return 1;
            if (isNaN(na) && !isNaN(nb)) return -1;
        }
        return 0;
    }

    private async checkOllamaConnection(): Promise<boolean> {
        try {
            const response = await fetch(`${this.settings.ollamaURL}/api/embeddings`, {
                method: 'HEAD'
            });
            return response.ok;
        } catch (error) {
            new Notice('Could not connect to Ollama server. Please check your settings and ensure Ollama is running.');
            console.error('[Vector Search] Ollama connection error:', error);
            return false;
        }
    }

    // Function to get embeddings from Ollama
    async getEmbedding(text: string): Promise<number[]> {
        try {
            const response = await fetch(`${this.settings.ollamaURL}/api/embeddings`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    model: this.settings.modelName,
                    prompt: text
                })
            });

            const data = await response.json();
            return data.embedding;
        } catch (error) {
            console.error('[Vector Search] Error getting embedding:', error);
            new Notice('Error getting embedding from Ollama');
            return [];
        }
    }

    // Calculate cosine similarity between two vectors
    cosineSimilarity(vec1: number[], vec2: number[]): number {
        const dotProduct = vec1.reduce((acc, val, i) => acc + val * vec2[i], 0);
        const mag1 = Math.sqrt(vec1.reduce((acc, val) => acc + val * val, 0));
        const mag2 = Math.sqrt(vec2.reduce((acc, val) => acc + val * val, 0));
        return dotProduct / (mag1 * mag2);
    }

    async buildVectorIndex() {
        this.vectorStore.clear();
        const files = this.app.vault.getMarkdownFiles();
        
        let processed = 0;
        const total = files.length;
        
        // Show initial progress
        const progressNotice = new Notice(
            `Indexing files: 0/${total} (0%)`,
            0 // Set duration to 0 to keep it persistent
        );
        
        for (const file of files) {
            const content = await this.app.vault.read(file);
            const embedding = await this.getEmbedding(content);
            this.vectorStore.set(file.path, embedding);
            
            processed++;
            // Update progress notice
            const percentage = Math.round((processed / total) * 100);
            progressNotice.setMessage(
                `Indexing files: ${processed}/${total} (${percentage}%)`
            );
        }
        
        // Close progress notice and show completion notice
        progressNotice.hide();
        new Notice('Vector index rebuilt successfully!');
    }
}

class SearchModal extends Modal {
    private plugin: VectorSearchPlugin;
    private searchInput: HTMLInputElement;
    private resultsDiv: HTMLDivElement;

    constructor(app: App, plugin: VectorSearchPlugin) {
        super(app);
        this.plugin = plugin;
    }

    onOpen() {
        const {contentEl} = this;
        contentEl.empty();
        
        // Create search input
        const searchContainer = contentEl.createDiv('search-container');
        this.searchInput = searchContainer.createEl('input', {
            type: 'text',
            placeholder: 'Type to search similar notes...'
        });
        
        // Create results container
        this.resultsDiv = contentEl.createDiv('search-results');
        
        // Handle search input
        this.searchInput.addEventListener('input', this.debounce(async () => {
            const query = this.searchInput.value;
            if (query.length < 3) {
                this.resultsDiv.empty();
                return;
            }
            await this.performSearch(query);
        }, this.plugin.settings.debounceTime));

        // Focus input
        this.searchInput.focus();
    }

    async performSearch(query: string) {
        if (this.plugin.vectorStore.size === 0) {
            this.resultsDiv.setText('Vector index is empty. Please rebuild the index first.');
            return;
        }

        const queryEmbedding = await this.plugin.getEmbedding(query);
        const results: Array<{path: string, similarity: number}> = [];

        for (const [path, embedding] of this.plugin.vectorStore.entries()) {
            const similarity = this.plugin.cosineSimilarity(queryEmbedding, embedding);
            if (similarity >= this.plugin.settings.searchThreshold) {
                results.push({ path, similarity });
            }
        }

        results.sort((a, b) => b.similarity - a.similarity);
        this.displayResults(results.slice(0, this.plugin.settings.maxResults));
    }

    displayResults(results: Array<{path: string, similarity: number}>) {
        this.resultsDiv.empty();
        
        if (results.length === 0) {
            this.resultsDiv.setText('No similar notes found');
            return;
        }

        const list = this.resultsDiv.createEl('ul');
        for (const result of results) {
            const item = list.createEl('li');
            const link = item.createEl('a', {
                text: `${result.path} (${(result.similarity * 100).toFixed(2)}%)`,
                href: '#'
            });
            link.addEventListener('click', async (e) => {
                e.preventDefault();
                const file = this.app.vault.getAbstractFileByPath(result.path);
                if (file instanceof TFile) {
                    await this.app.workspace.getLeaf().openFile(file);
                    this.close();
                }
            });
        }
    }

    debounce(func: Function, wait: number) {
        let timeout: NodeJS.Timeout;
        return (...args: any[]) => {
            clearTimeout(timeout);
            timeout = setTimeout(() => func.apply(this, args), wait);
        };
    }

    onClose() {
        const {contentEl} = this;
        contentEl.empty();
    }
}

class VectorSearchSettingTab extends PluginSettingTab {
    plugin: VectorSearchPlugin;

    constructor(app: App, plugin: VectorSearchPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const {containerEl} = this;
        containerEl.empty();
        containerEl.createEl('h2', {text: 'Vector Search Settings'});

        // Server Settings Section
        containerEl.createEl('h3', {text: 'Server Settings'});
        
        new Setting(containerEl)
            .setName('Ollama URL')
            .setDesc('URL of your Ollama server')
            .addText(text => text
                .setPlaceholder('http://localhost:11434')
                .setValue(this.plugin.settings.ollamaURL)
                .onChange(async (value) => {
                    this.plugin.settings.ollamaURL = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Model Name')
            .setDesc('Name of the embedding model to use')
            .addText(text => text
                .setPlaceholder('nomic-embed-text')
                .setValue(this.plugin.settings.modelName)
                .onChange(async (value) => {
                    this.plugin.settings.modelName = value;
                    await this.plugin.saveSettings();
                }));

        // Search Settings Section
        containerEl.createEl('h3', {text: 'Search Settings'});

        new Setting(containerEl)
            .setName('Search Threshold')
            .setDesc('Minimum similarity score (0-1) for showing results')
            .addSlider(slider => slider
                .setLimits(0, 1, 0.05)
                .setValue(this.plugin.settings.searchThreshold)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.searchThreshold = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Maximum Results')
            .setDesc('Maximum number of search results to display')
            .addSlider(slider => slider
                .setLimits(1, 50, 1)
                .setValue(this.plugin.settings.maxResults)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.maxResults = value;
                    await this.plugin.saveSettings();
                }));

        // Advanced Settings Section
        containerEl.createEl('h3', {text: 'Advanced Settings'});

        new Setting(containerEl)
            .setName('Chunk Size')
            .setDesc('Number of characters per text chunk (0 for no chunking)')
            .addSlider(slider => slider
                .setLimits(0, 2000, 100)
                .setValue(this.plugin.settings.chunkSize)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.chunkSize = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Debounce Time')
            .setDesc('Delay in milliseconds before searching after typing')
            .addSlider(slider => slider
                .setLimits(100, 1000, 50)
                .setValue(this.plugin.settings.debounceTime)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.debounceTime = value;
                    await this.plugin.saveSettings();
                }));
    }
}