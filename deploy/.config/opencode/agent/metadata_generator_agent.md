# Agent Metadata Generator

This agent generates metadata for coding agents based on user prompts. It creates concise, descriptive titles (≤40 characters) that capture the essence of what a coding agent should do based on the given user prompt.

## Usage

When invoked, this agent:
1. Analyzes the user prompt to understand the desired functionality
2. Generates a short, descriptive title (≤40 characters) for a coding agent
3. Returns only JSON with the single field 'title'

## Example

Input: "Create an agent that helps debug Python code by analyzing stack traces"
Output: {"title": "Python Debugging Agent"}

The agent focuses on brevity and clarity while ensuring the title accurately reflects the agent's purpose.