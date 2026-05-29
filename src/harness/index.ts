// Harness — cross-cutting policy enforcement merged into the PMS plugin.
//
// Previously these lived as separate opencode plugins in
// `~/.opencode/plugins/` (parallel-detector, criteria-validator,
// dispatch-judge, deploy-fanout). They each had to be loaded with a thin
// wrapper because opencode's plugin loader rejects modules with named
// exports. Folding them into PMS removes that drift surface — one plugin,
// one place, one deploy.
//
// Each module exports a `createXHook(ctx)` factory that returns just the
// hook handlers it owns. `src/index.ts` calls these at init and chains the
// returned handlers into its existing hook handlers.

export { createParallelDetectorHook } from './parallel-detector';
export { createCriteriaValidatorHook } from './criteria-validator';
export { createDispatchJudgeHook } from './dispatch-judge';
export { createHarnessDeployTool } from './deploy-fanout';
export {
  cheapClassifierSessionIds,
  looksLikeCheapClassifierPrompt,
} from './_lib/cheap-classifier';
export {
  containsHarnessMark,
  emitHarnessMark,
  extractHarnessMarks,
  tripLoopGuard,
} from './_lib/loop-guard';
