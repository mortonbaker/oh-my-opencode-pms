/**
 * Subtask functionality for session continuation.
 *
 * Provides tools and commands for creating subtask prompts that allow
 * work to continue seamlessly in new sessions with preloaded context.
 */

export {
  createSubtaskCommandManager,
  type SubtaskCommandManager,
} from './command';
export {
  buildSyntheticFileParts,
  FILE_REGEX,
  parseFileReferences,
} from './files';
export { createSubtaskState, type SubtaskState } from './state';
export {
  createReadSessionTool,
  createSubtaskTool,
  type OpencodeClient,
} from './tools';
export {
  DEFAULT_READ_LIMIT,
  formatFileContent,
  isBinaryFile,
  MAX_BYTES,
  MAX_LINE_LENGTH,
} from './vendor';
