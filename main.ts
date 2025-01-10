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
}

const DEFAULT_SETTINGS: MyPluginSettings = {
    ollamaURL: 'http://localhost:11434',
    searchThreshold: 0.8
}

export default class VectorSearchPlugin extends Plugin {
    settings: MyPluginSettings;
    vectorStore: Map<string, number[]> = new Map();

    async onload() {
        await this.loadSettings();

        // Add a ribbon icon for rebuilding the vector index
        this.addRibbonIcon('refresh-cw', 'Rebuild Vector Index', async () => {
            await this.buildVectorIndex();
            new Notice('Vector index rebuilt!');
        });

        // Add a command to search similar notes
        this.addCommand({
            id: 'search-similar-notes',
            name: 'Search Similar Notes',
            editorCallback: async (editor: Editor, view: MarkdownView) => {
                const selection = editor.getSelection();
                if (selection) {
                    await this.searchSimilarNotes(selection);
                } else {
                    new Notice('Please select some text to search');
                }
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

    // Function to get embeddings from Ollama
    async getEmbedding(text: string): Promise<number[]> {
        try {
            console.log(`[Vector Search] Requesting embedding for text of length ${text.length}`);
            const response = await fetch(`${this.settings.ollamaURL}/api/embeddings`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    model: 'nomic-embed-text',
                    prompt: text
                })
            });

            const data = await response.json();
            console.log(`[Vector Search] Successfully received embedding of length ${data.embedding.length}`);
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
        console.log('[Vector Search] Starting vector index build');
        this.vectorStore.clear();
        const files = this.app.vault.getMarkdownFiles();
        
        let processed = 0;
        const total = files.length;
        
        for (const file of files) {
            console.log(`[Vector Search] Processing file: ${file.path}`);
            const content = await this.app.vault.read(file);
            const embedding = await this.getEmbedding(content);
            this.vectorStore.set(file.path, embedding);
            
            processed++;
            if (processed % 10 === 0) {
                console.log(`[Vector Search] Progress: ${processed}/${total} files`);
                new Notice(`Indexing progress: ${processed}/${total} files`);
            }
        }
        console.log('[Vector Search] Completed vector index build');
    }

    async searchSimilarNotes(query: string) {
        if (this.vectorStore.size === 0) {
            new Notice('Vector index is empty. Please rebuild the index first.');
            return;
        }

        const queryEmbedding = await this.getEmbedding(query);
        const results: Array<{path: string, similarity: number}> = [];

        for (const [path, embedding] of this.vectorStore.entries()) {
            const similarity = this.cosineSimilarity(queryEmbedding, embedding);
            if (similarity >= this.settings.searchThreshold) {
                results.push({ path, similarity });
            }
        }

        results.sort((a, b) => b.similarity - a.similarity);
        
        if (results.length > 0) {
            new SimilarNotesModal(this.app, results).open();
        } else {
            new Notice('No similar notes found');
        }
    }
}

class SimilarNotesModal extends Modal {
    results: Array<{path: string, similarity: number}>;

    constructor(app: App, results: Array<{path: string, similarity: number}>) {
        super(app);
        this.results = results;
    }

    onOpen() {
        const {contentEl} = this;
        contentEl.empty();
        
        contentEl.createEl('h2', {text: 'Similar Notes'});
        
        const list = contentEl.createEl('ul');
        for (const result of this.results) {
            const item = list.createEl('li');
            const link = item.createEl('a', {
                text: `${result.path} (${(result.similarity * 100).toFixed(2)}%)`,
                href: '#'
            });
            link.addEventListener('click', async (e) => {
                e.preventDefault();
                const file = this.app.vault.getAbstractFileByPath(result.path);
                if (file instanceof TFile) {
                    await this.app.workspace.activeLeaf.openFile(file);
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
            .setName('Search Threshold')
            .setDesc('Minimum similarity score (0-1) for showing results')
            .addSlider(slider => slider
                .setLimits(0, 1, 0.1)
                .setValue(this.plugin.settings.searchThreshold)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.searchThreshold = value;
                    await this.plugin.saveSettings();
                }));
    }
}