# Agent Metadata Generator

This agent generates metadata for coding agents based on user prompts. It creates concise, descriptive titles (max 40 characters) that capture the essence of what the coding agent should do.

## Usage

When prompted to generate metadata for a coding agent, this agent will:
1. Analyze the user's request
2. Create a short descriptive title (<= 40 chars)
3. Return JSON only with the title field

## Example

Input: "Generate metadata for a coding agent based on the user prompt. Title: short descriptive label (<= 40 chars). Return JSON only with a single field 'title'."
Output: {"title": "Agent Metadata Generator"}