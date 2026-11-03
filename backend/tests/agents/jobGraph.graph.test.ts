import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { MemorySaver } from '@langchain/langgraph';

const jobMatch = jest.fn<(state: any) => Promise<any>>();
const decide = jest.fn<(state: any) => Promise<any>>();
const checkpointer = new MemorySaver();

jest.unstable_mockModule('../../src/agents/checkpointer.ts', () => ({ checkpointer }));
jest.unstable_mockModule('../../src/agents/jobGraph/nodes.ts', () => ({ jobMatch, decide }));

const { jobGraph, runJobThread } = await import('../../src/agents/jobGraph/graph.ts');
const { GRAPH_VERSION } = await import('../../src/agents/jobGraph/state.ts');

beforeEach(() => {
  jobMatch.mockReset().mockResolvedValue({ match_score: 72, rationale: 'Good fit.', instruction_ids: ['instruction-1'] });
  decide.mockReset().mockResolvedValue({ decision: 'APPLY', requires_approval: true });
});

describe('runJobThread', () => {
  it('runs jobMatch then decide and returns the final state', async () => {
    const result = await runJobThread('thread-1', { user_id: 'user-1', job_id: 'job-1' });

    expect(jobMatch).toHaveBeenCalledTimes(1);
    expect(decide.mock.calls[0]![0]).toMatchObject({ match_score: 72 });
    expect(result).toEqual({
      user_id: 'user-1',
      job_id: 'job-1',
      match_score: 72,
      rationale: 'Good fit.',
      instruction_ids: ['instruction-1'],
      decision: 'APPLY',
      requires_approval: true,
      graph_version: GRAPH_VERSION,
    });
  });

  it('checkpoints the finished state under the thread id', async () => {
    await runJobThread('thread-2', { user_id: 'user-1', job_id: 'job-1' });

    const saved = await jobGraph.getState({ configurable: { thread_id: 'thread-2' } });
    expect(saved.values).toMatchObject({ match_score: 72, decision: 'APPLY' });
    expect(saved.next).toEqual([]);
  });

  it('keeps separate threads apart', async () => {
    await runJobThread('thread-a', { user_id: 'user-1', job_id: 'job-1' });
    decide.mockResolvedValue({ decision: 'DO_NOT_APPLY' });
    await runJobThread('thread-b', { user_id: 'user-2', job_id: 'job-2' });

    const a = await jobGraph.getState({ configurable: { thread_id: 'thread-a' } });
    const b = await jobGraph.getState({ configurable: { thread_id: 'thread-b' } });
    expect(a.values.decision).toBe('APPLY');
    expect(b.values).toMatchObject({ user_id: 'user-2', decision: 'DO_NOT_APPLY' });
  });
});
