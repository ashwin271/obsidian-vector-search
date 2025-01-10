# Obsidian Vector Search Plugin

This plugin adds semantic search capabilities to Obsidian using Ollama's embedding API. It allows you to find semantically similar notes based on content rather than just keyword matching.

## Features

-   🔍 Semantic search across your entire vault
-   🤖 Powered by Ollama's embedding model
-   📊 Configurable similarity threshold
-   🚀 Fast local search once embeddings are generated

## Prerequisites

-   [Ollama](https://ollama.ai/) installed and running locally
-   The `nomic-embed-text` model pulled in Ollama

## Installation

1. Clone this repo to your `.obsidian/plugins/` folder
2. Install dependencies: `npm install`
3. Build the plugin: `npm run dev`
4. Enable the plugin in Obsidian's settings

## Usage

1. **Initial Setup**

    - Go to Settings > Vector Search
    - Configure your Ollama URL (default: http://localhost:11434)
    - Set your desired similarity threshold (0-1)

2. **Building the Index**

    - Click the vector search icon in the ribbon
    - Wait for all notes to be processed (progress will be shown)

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
	"searchThreshold": 0.7
}
```
