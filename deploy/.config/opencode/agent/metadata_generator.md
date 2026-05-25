# Agent Metadata Generator

This agent generates metadata for coding agents based on user prompts. It creates concise, descriptive titles (≤40 characters) that capture the essence of what the coding agent should do.

## Usage

When prompted to generate metadata for a coding agent, this agent will:
1. Analyze the user's request to understand the agent's purpose
2. Create a short, descriptive title (≤40 characters)
3. Return the metadata in JSON format with only the "title" field

## Example

User prompt: "Create an agent that helps debug Python code"
Output: {"title": "Python Debugging Assistant"}