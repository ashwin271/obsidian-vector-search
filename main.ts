import { 
    App, 
    Modal, 
    Notice, 
    Plugin, 
    PluginSettingTab, 
    Setting,
    TFile,
    normalizePath,
    debounce,
    Debouncer
} from 'obsidian';

interface VectorData {
    path: string;
    embedding: number[];
    title: string;
    chunkIndex: number;
    startLine: number;
    endLine: number;
}

interface VectorSearchPluginSettings {
    ollamaURL: string;
    searchThreshold: number;
    maxResults: number;
    chunkSize: number;
    chunkOverlap: number;
    chunkingStrategy: 'character' | 'paragraph';
    debounceTime: number;
    fileProcessingDebounceTime: number;
    modelName: string;
    vectors: VectorData[];
}

const DEFAULT_SETTINGS: VectorSearchPluginSettings = {
    ollamaURL: 'http://localhost:11434',
    searchThreshold: 0.5,
    maxResults: 10,
    chunkSize: 500,
    chunkOverlap: 100,
    chunkingStrategy: 'paragraph',
    debounceTime: 300,
    fileProcessingDebounceTime: 2000,
    modelName: 'nomic-embed-text:latest',
    vectors: [] 
}

export default class VectorSearchPlugin extends Plugin {
    settings: VectorSearchPluginSettings;
    vectorStore: Map<string, VectorData> = new Map();
    private debouncedProcessFile: Debouncer<[file: TFile], Promise<void>>;
    private requirementsOk: boolean | null = null;
    private isIndexing = false;

    async onload() {

        await this.loadSettings();

        // Initialize debounced function after settings are loaded
        this.debouncedProcessFile = debounce(
            async (file: TFile) => {
                await this.processFile(file);
            }, 
            this.settings.fileProcessingDebounceTime
        );

        this.registerEvent(
            this.app.vault.on('modify', async (file) => {
                if (file instanceof TFile && file.extension === 'md') {
                    this.debouncedProcessFile(file);
                }
            })
        );

        this.registerEvent(
            this.app.vault.on('rename', async (file, oldPath) => {
                if (file instanceof TFile && file.extension === 'md') {
                    this.removeFileVectors(oldPath);
                    await this.debouncedProcessFile(file);
                }
            })
        );
    
        this.registerEvent(
            this.app.vault.on('delete', (file) => {
                if (file instanceof TFile && file.extension === 'md') {
                    this.removeFileVectors(file.path);
                    this.saveSettings();
                }
            })
        );
        
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
        // Populate vectorStore from settings
        this.vectorStore = new Map(
            this.settings.vectors.map((v, index) => {
                const chunkIndex = Number.isFinite(v.chunkIndex) ? v.chunkIndex : index;
                const key = `${v.path}#${chunkIndex}`;
                return [key, { ...v, chunkIndex }];
            })
        );
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    private markRequirementsStale(): void {
        this.requirementsOk = null;
    }

    private removeFileVectors(filePath: string): void {
        // Remove all vectors for the given file path
        const normalizedPath = normalizePath(filePath);
        for (const [key, value] of this.vectorStore.entries()) {
            if (value.path === normalizedPath) {
                this.vectorStore.delete(key);
            }
        }
    }

    private async processFile(file: TFile): Promise<void> {
        try {
            const isReady = await this.ensureRequirements(false);
            if (!isReady) {
                return;
            }

            const content = await this.app.vault.read(file);
            const chunks = this.splitIntoChunks(content);
            
            // Remove existing vectors for this file
            this.removeFileVectors(file.path);
            
            for (let i = 0; i < chunks.length; i++) {
                const chunk = chunks[i];
                const startLine = content.slice(0, content.indexOf(chunk)).split('\n').length - 1;
                const endLine = startLine + chunk.split('\n').length;
                
                const embedding = await this.getEmbedding(chunk);
                if (!embedding || embedding.length === 0) {
                    throw new Error('Failed to generate embedding');
                }
                
                const vectorData: VectorData = {
                    path: normalizePath(file.path),
                    embedding: embedding,
                    title: `${file.basename} (chunk ${i + 1}/${chunks.length})`,
                    chunkIndex: i,
                    startLine,
                    endLine
                };
                
                const key = `${vectorData.path}#${i}`;
                this.vectorStore.set(key, vectorData);
            }
            
            // Save after successful processing
            this.settings.vectors = Array.from(this.vectorStore.values());
            await this.saveSettings();
            
        } catch (error) {
            console.error(`Failed to process file ${file.path}:`, error);
            new Notice(`Failed to process file: ${file.basename}`);
        }
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

    private async checkRequirements(showNotice: boolean): Promise<boolean> {
        try {
            // Check if Ollama is running
            const ollamaResponse = await fetch(`${this.settings.ollamaURL}/api/version`, {
                method: 'GET'
            });

            if (!ollamaResponse.ok) {
                if (showNotice) {
                    new Notice('Could not connect to Ollama server. Please ensure Ollama is installed and running.');
                }
                console.error('[Vector Search] Ollama connection failed');
                return false;
            }

            // Check if the model is available
            const modelResponse = await fetch(`${this.settings.ollamaURL}/api/tags`, {
                method: 'GET'
            });

            if (!modelResponse.ok) {
                if (showNotice) {
                    new Notice('Could not check available models. Please verify Ollama installation.');
                }
                return false;
            }

            const models = await modelResponse.json();
            const hasModel = models.models?.some((model: any) => 
                model.name === this.settings.modelName
            );

            if (!hasModel) {
                if (showNotice) {
                    new Notice(`Required model '${this.settings.modelName}' not found. Please run: ollama pull ${this.settings.modelName}`);
                }
                console.error('[Vector Search] Required model not installed');
                return false;
            }

            return true;

        } catch (error) {
            if (showNotice) {
                new Notice(`
                    Vector Search Plugin Requirements Not Met:
                    1. Install Ollama from ollama.ai
                    2. Start Ollama service
                    3. Run: ollama pull ${this.settings.modelName}
                `);
            }
            console.error('[Vector Search] Requirements check failed:', error);
            return false;
        }
    }

    private async ensureRequirements(showNotice: boolean): Promise<boolean> {
        if (this.requirementsOk === true) {
            return true;
        }

        if (!showNotice && this.requirementsOk === false) {
            return false;
        }

        const isReady = await this.checkRequirements(showNotice);
        this.requirementsOk = isReady;
        return isReady;
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

    private splitIntoChunks(content: string): string[] {
        if (this.settings.chunkSize === 0) {
            return [content];
        }

        if (this.settings.chunkingStrategy === 'paragraph') {
            const paragraphs = content.split(/\n\s*\n/);
            const chunks: string[] = [];
            let currentChunk = '';

            for (const paragraph of paragraphs) {
                if ((currentChunk + paragraph).length > this.settings.chunkSize) {
                    if (currentChunk) {
                        chunks.push(currentChunk.trim());
                    }
                    currentChunk = paragraph;
                } else {
                    currentChunk = currentChunk ? `${currentChunk}\n\n${paragraph}` : paragraph;
                }
            }
            if (currentChunk) {
                chunks.push(currentChunk.trim());
            }
            return chunks;
        }

        // Character-based chunking
        const chunks: string[] = [];
        let i = 0;
        while (i < content.length) {
            const chunk = content.slice(i, i + this.settings.chunkSize);
            chunks.push(chunk);
            i += this.settings.chunkSize - this.settings.chunkOverlap;
        }
        return chunks;
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
        const isReady = await this.ensureRequirements(true);
        if (!isReady) {
            return;
        }

        if (this.isIndexing) {
            new Notice('Indexing already in progress.');
            return;
        }

        this.isIndexing = true;
        this.vectorStore.clear();
        const files = this.app.vault.getMarkdownFiles();
        
        let processed = 0;
        const total = files.length;
        
        const progressNotice = new Notice(
            `Indexing files: 0/${total} (0%)`,
            0
        );
        
        try {
            for (const file of files) {
                const content = await this.app.vault.read(file);
                const chunks = this.splitIntoChunks(content);
                
                for (let i = 0; i < chunks.length; i++) {
                    const chunk = chunks[i];
                    const startLine = content.slice(0, content.indexOf(chunk)).split('\n').length - 1;
                    const endLine = startLine + chunk.split('\n').length;
                    
                    const embedding = await this.getEmbedding(chunk);
                    
                    const vectorData: VectorData = {
                        path: normalizePath(file.path),
                        embedding: embedding,
                        title: `${file.basename} (chunk ${i + 1}/${chunks.length})`,
                        chunkIndex: i,
                        startLine,
                        endLine
                    };
                    
                    const key = `${vectorData.path}#${i}`;
                    this.vectorStore.set(key, vectorData);
                }
                
                processed++;
                progressNotice.setMessage(
                    `Indexing files: ${processed}/${total} (${Math.round((processed / total) * 100)}%)`
                );
            }

            this.settings.vectors = Array.from(this.vectorStore.values());
            await this.saveSettings();
            
            new Notice('Vector index rebuilt successfully!');
        } finally {
            progressNotice.hide();
            this.isIndexing = false;
        }
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

        const isReady = await this.plugin.ensureRequirements(true);
        if (!isReady) {
            this.resultsDiv.setText('Ollama is unavailable. Check the plugin settings and try again.');
            return;
        }

        const queryEmbedding = await this.plugin.getEmbedding(query);
        const results: Array<{vectorData: VectorData, similarity: number}> = [];

        for (const vectorData of this.plugin.vectorStore.values()) {
            const similarity = this.plugin.cosineSimilarity(queryEmbedding, vectorData.embedding);
            if (similarity >= this.plugin.settings.searchThreshold) {
                results.push({ vectorData, similarity });
            }
        }

        results.sort((a, b) => b.similarity - a.similarity);
        this.displayResults(results.slice(0, this.plugin.settings.maxResults));
    }

    displayResults(results: Array<{vectorData: VectorData, similarity: number}>) {
        this.resultsDiv.empty();
        
        if (results.length === 0) {
            this.resultsDiv.setText('No similar notes found');
            return;
        }

        const list = this.resultsDiv.createEl('ul');
        for (const result of results) {
            const item = list.createEl('li');
            const link = item.createEl('a', {
                text: `${result.vectorData.title} (${(result.similarity * 100).toFixed(2)}%)`,
                href: '#'
            });
            
            // Add line numbers info
            item.createEl('div', {
                text: `Lines ${result.vectorData.startLine}-${result.vectorData.endLine}`,
                cls: 'search-result-lines'
            });

            link.addEventListener('click', async (e) => {
                e.preventDefault();
                const file = this.app.vault.getAbstractFileByPath(result.vectorData.path);
                if (file instanceof TFile) {
                    await this.app.workspace.getLeaf().openFile(file);
                    // TODO: Scroll to specific line if needed
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
                    this.plugin.markRequirementsStale();
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
                    this.plugin.markRequirementsStale();
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

        new Setting(containerEl)
            .setName('File processing delay')
            .setDesc('Delay in milliseconds before processing file changes')
            .addSlider(slider => slider
                .setLimits(500, 5000, 500)
                .setValue(this.plugin.settings.fileProcessingDebounceTime)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.fileProcessingDebounceTime = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl).setName('Chunking options').setHeading();


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
            .setName('Chunking strategy')
            .setDesc('How to split documents into chunks')
            .addDropdown(dropdown => dropdown
                .addOption('character', 'Character-based')
                .addOption('paragraph', 'Paragraph-based')
                .setValue(this.plugin.settings.chunkingStrategy)
                .onChange(async (value: 'character' | 'paragraph') => {
                    this.plugin.settings.chunkingStrategy = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Chunk overlap')
            .setDesc('Number of characters to overlap between chunks')
            .addSlider(slider => slider
                .setLimits(0, 200, 10)
                .setValue(this.plugin.settings.chunkOverlap)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.chunkOverlap = value;
                    await this.plugin.saveSettings();
                }));
    }
}
