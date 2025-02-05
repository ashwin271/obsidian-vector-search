import { 
    App, 
    Modal, 
    Notice, 
    Plugin, 
    PluginSettingTab, 
    Setting,
    TFile,
    normalizePath,
    debounce
} from 'obsidian';

interface VectorSearchPluginSettings {
    ollamaURL: string;
    searchThreshold: number;
    maxResults: number;
    chunkSize: number;
    debounceTime: number;
    modelName: string;
}

const DEFAULT_SETTINGS: VectorSearchPluginSettings = {
    ollamaURL: 'http://localhost:11434',
    searchThreshold: 0.8,
    maxResults: 10,
    chunkSize: 500,
    debounceTime: 300,
    modelName: 'nomic-embed-text:latest'
}

export default class VectorSearchPlugin extends Plugin {
    settings: VectorSearchPluginSettings;
    vectorStore: Map<string, number[]> = new Map();

    async onload() {

        await this.loadSettings();
        
        // Check Ollama and model availability before enabling plugin features
        const isReady = await this.checkRequirements();
        if (!isReady) {
            return; // Don't load plugin features if requirements aren't met
        }

        // Add a ribbon icon for rebuilding the vector index
        this.addRibbonIcon('refresh-cw', 'Rebuild vector index', async () => {
            await this.buildVectorIndex();
            new Notice('Vector index rebuilt!');
        });

        // Add a command to open search modal
        this.addCommand({
            id: 'search-similar-notes',
            name: 'Search similar notes',
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

    private async checkRequirements(): Promise<boolean> {
        try {
            // Check if Ollama is running
            const ollamaResponse = await fetch(`${this.settings.ollamaURL}/api/version`, {
                method: 'GET'
            });

            if (!ollamaResponse.ok) {
                new Notice('Could not connect to Ollama server. Please ensure Ollama is installed and running.');
                console.error('[Vector Search] Ollama connection failed');
                return false;
            }

            // Check if the model is available
            const modelResponse = await fetch(`${this.settings.ollamaURL}/api/tags`, {
                method: 'GET'
            });

            if (!modelResponse.ok) {
                new Notice('Could not check available models. Please verify Ollama installation.');
                return false;
            }

            const models = await modelResponse.json();
            const hasModel = models.models?.some((model: any) => 
                model.name === this.settings.modelName
            );

            if (!hasModel) {
                new Notice(`Required model '${this.settings.modelName}' not found. Please run: ollama pull ${this.settings.modelName}`);
                console.error('[Vector Search] Required model not installed');
                return false;
            }

            return true;

        } catch (error) {
            new Notice(`
                Vector Search Plugin Requirements Not Met:
                1. Install Ollama from ollama.ai
                2. Start Ollama service
                3. Run: ollama pull ${this.settings.modelName}
            `);
            console.error('[Vector Search] Requirements check failed:', error);
            return false;
        }
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
            // Add normalization here:
            const normalizedPath = normalizePath(file.path);
            this.vectorStore.set(normalizedPath, embedding);
            
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
        const debouncedSearch = debounce(async () => {
            const query = this.searchInput.value;
            if (query.length < 3) {
                this.resultsDiv.empty();
                return;
            }
            await this.performSearch(query);
        }, this.plugin.settings.debounceTime, true);

        this.searchInput.addEventListener('input', debouncedSearch);


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
                const normalizedPath = normalizePath(result.path);
                const file = this.app.vault.getAbstractFileByPath(normalizedPath);
                if (file instanceof TFile) {
                    await this.app.workspace.getLeaf().openFile(file);
                    this.close();
                }
            });
        }
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

        new Setting(containerEl).setName('Server configuration').setHeading();
        
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
            .setName('Model name')
            .setDesc('Name of the embedding model to use')
            .addText(text => text
                .setPlaceholder('nomic-embed-text:latest')
                .setValue(this.plugin.settings.modelName)
                .onChange(async (value) => {
                    this.plugin.settings.modelName = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl).setName('Search options').setHeading();

        new Setting(containerEl)
            .setName('Search threshold')
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
            .setName('Maximum results')
            .setDesc('Maximum number of search results to display')
            .addSlider(slider => slider
                .setLimits(1, 50, 1)
                .setValue(this.plugin.settings.maxResults)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.maxResults = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl).setName('Advanced options').setHeading();

        new Setting(containerEl)
            .setName('Chunk size')
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
            .setName('Debounce time')
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