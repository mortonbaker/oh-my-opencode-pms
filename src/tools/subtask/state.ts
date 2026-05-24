export interface SubtaskState {
  markSession(sessionID: string, sourceSessionID: string): void;
  unmarkSession(sessionID: string): void;
  isSubtaskSession(sessionID: string): boolean;
  sourceFor(sessionID: string): string | undefined;
}

export function createSubtaskState(): SubtaskState {
  const sourceBySession = new Map<string, string>();

  return {
    markSession(sessionID: string, sourceSessionID: string): void {
      sourceBySession.set(sessionID, sourceSessionID);
    },
    unmarkSession(sessionID: string): void {
      sourceBySession.delete(sessionID);
    },
    isSubtaskSession(sessionID: string): boolean {
      return sourceBySession.has(sessionID);
    },
    sourceFor(sessionID: string): string | undefined {
      return sourceBySession.get(sessionID);
    },
  };
}
