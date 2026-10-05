import { describe, it, expect, vi } from 'vitest';
import { AxiosError, AxiosHeaders } from 'axios';
import { createProject } from '../../src/services/api/projects';
import type { ResourceContext } from '../../src/services/api/types';
import { UserFacingError } from '../../src/utils/errors';

function makeAxiosError(status: number, data: unknown): AxiosError {
  const config = { headers: new AxiosHeaders(), method: 'post' } as any;
  return new AxiosError(`Request failed with status code ${status}`, 'ERR_BAD_REQUEST', config, {}, {
    status,
    statusText: 'Bad Request',
    headers: {},
    config,
    data,
  });
}

function makeMockCtx(post: ReturnType<typeof vi.fn>): ResourceContext {
  return {
    api: {
      client: { post } as any,
      requestWithRetry: vi.fn().mockImplementation((fn: () => any) => fn()),
      formatApiError: vi.fn().mockImplementation(() => new Error('generic formatted error')),
    } as any,
    cache: { project: { invalidate: vi.fn() } } as any,
  };
}

describe('createProject', () => {
  it('sends projectDefinitionId and stages in the request body', async () => {
    const post = vi.fn().mockResolvedValue({ data: { id: 'p1', name: 'Proj' } });
    const ctx = makeMockCtx(post);
    const stages = [{ stageDefinitionId: 'std_1', dueDate: '2026-11-01T23:59:59.000Z' }];

    await createProject(ctx, { name: 'Proj', workspaceId: 'w1', projectDefinitionId: 'pde_1', stages });

    expect(post).toHaveBeenCalledWith('/projects', expect.objectContaining({
      name: 'Proj',
      workspaceId: 'w1',
      projectDefinitionId: 'pde_1',
      stages,
    }));
  });

  it('surfaces the Motion API message on a 400 (e.g. stage count mismatch)', async () => {
    const apiMessage = 'The number of stages in the project does not match the number of stages in the definition. Expected stages: [std_1, std_2]';
    const post = vi.fn().mockRejectedValue(makeAxiosError(400, { message: apiMessage }));
    const ctx = makeMockCtx(post);

    const error = await createProject(ctx, { name: 'Proj', workspaceId: 'w1' }).catch(e => e);

    expect(error).toBeInstanceOf(UserFacingError);
    expect(error.message).toContain(apiMessage);
    expect(error.statusCode).toBe(400);
  });

  it('falls back to the standard error formatting for non-400 errors', async () => {
    const post = vi.fn().mockRejectedValue(makeAxiosError(500, { message: 'boom' }));
    const ctx = makeMockCtx(post);

    const error = await createProject(ctx, { name: 'Proj', workspaceId: 'w1' }).catch(e => e);

    expect(error.message).toBe('generic formatted error');
  });
});
