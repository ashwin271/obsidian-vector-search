# Obsidian Vector Search Plugin

This plugin adds semantic search capabilities to Obsidian using Ollama's embedding API. It allows you to find semantically similar notes based on content rather than just keyword matching.

## Features

-   🔍 Semantic search across your entire vault
-   🤖 Powered by Ollama's embedding model
-   📊 Configurable similarity threshold
-   🚀 Fast local search once embeddings are generated
-   ⚡ Automatic file change detection and updates
-   📝 Smart text chunking strategies
-   🔄 Efficient incremental updates

## Prerequisites

### 1. Ollama Setup

-   Install [Ollama](https://ollama.ai/) for your platform:
    -   **macOS**: Download from [ollama.ai](https://ollama.ai)
    -   **Linux**: Run `curl -fsSL https://ollama.ai/install.sh | sh`
    -   **Windows**: Currently in beta, follow instructions on [ollama.ai](https://ollama.ai)
-   Verify installation by running `ollama --version` in terminal
-   Start Ollama service:
    -   It should run automatically on macOS
    -   On Linux: `systemctl start ollama` or run `ollama serve`
    -   On Windows: Run Ollama from Start Menu

### 2. Model Installation

-   Pull the required embedding model:

```bash
ollama pull nomic-embed-text
```

-   Verify model installation:

```bash
ollama list
```

-   Expected size: ~500MB
-   First-time embedding generation might be slower

### 3. System Requirements

-   Minimum 1GB RAM for Ollama service
-   ~500MB disk space for the model
-   Stable internet connection for initial model download
-   Port 11434 must be available (default Ollama port)

### 4. Troubleshooting

1. If Ollama service isn't responding:

    ```bash
    curl http://localhost:11434/api/embeddings
    ```

    Should return a response (even if error)

2. Common issues:
    - Port 11434 in use: Change port in Ollama config
    - Permission denied: Run with sudo on Linux
    - Model download fails: Check internet connection
    - High CPU usage: Normal during first few runs

## Installation

1. Clone this repo to your `.obsidian/plugins/` folder
2. Install dependencies: `npm install`
3. Build the plugin: `npm run dev`
4. Enable the plugin in Obsidian's settings

## Usage

1. **Initial Setup**

    - Go to Settings > Vector Search (restart Obsidian if you do not see this under "Community plugins")
    - Configure your Ollama URL (default: http://localhost:11434)
    - Set your desired similarity threshold (0-1)

2. **Building the Index**

    - In the ribbon bar to the left, click the vector search icon ⟲ (restart Obsidian if the icon is not visible yet)

3. **Searching**
    - Select any text in a note
    - Use the command "Find Similar Notes" (or set up a hotkey)
    - View results in the popup modal

## How it Works

1. The plugin creates vector embeddings for all your markdown notes using Ollama
2. When you search, it:
    - Creates an embedding for your selected text
    - Uses cosine similarity to find the most similar notes
    - Shows results above your configured threshold

## Development

-   `npm run dev` - Start compilation in watch mode
-   `npm run build` - Build the plugin
-   `npm test` - Run tests

## Logs

The plugin logs all API calls and operations to the Developer Console (Ctrl+Shift+I or Cmd+Option+I on Mac). This includes:

-   Embedding API requests
-   Index building progress
-   File processing status
-   Any errors or issues

## Configuration

```json
{
    "ollamaURL": "http://localhost:11434",
    "searchThreshold": 0.7,
    "chunkSize": 500,
    "chunkOverlap": 100,
    "chunkingStrategy": "paragraph",
    "fileProcessingDebounceTime": 2000
}
```

### Chunking Strategies
- **Paragraph**: Splits text by paragraphs (default)
- **Character**: Splits text by character count with overlap

### File Processing
- Automatically detects file changes
- Updates vectors when files are modified
- Handles file renames and deletions
- Debounced processing to prevent overload
