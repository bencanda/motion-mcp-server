import { describe, it, expect, vi } from 'vitest';
import { ProjectHandler } from '../src/handlers';
import type { HandlerContext } from '../src/handlers/base/HandlerInterface';

function makeContext(overrides: Partial<HandlerContext> = {}): HandlerContext {
  const motionService = {
    createProject: vi.fn().mockResolvedValue({ id: 'p1', name: 'Proj' }),
    getProjects: vi.fn().mockResolvedValue({
      items: [
        { id: 'p1', name: 'A', description: '', workspaceId: 'w1' },
        { id: 'p2', name: 'B', description: '', workspaceId: 'w1' },
      ],
      truncation: undefined,
    }),
    getProject: vi.fn().mockResolvedValue({ id: 'p1', name: 'A', description: '', workspaceId: 'w1' }),
  } as any;

  const workspaceResolver = {
    resolveWorkspace: vi.fn().mockResolvedValue({ id: 'w1', name: 'Dev' })
  } as any;

  const validator = {} as any;

  return {
    motionService,
    workspaceResolver,
    validator,
    ...overrides,
  } as HandlerContext;
}

describe('ProjectHandler', () => {
  it('creates a project using resolved workspace', async () => {
    const ctx = makeContext();
    const handler = new ProjectHandler(ctx);
    const res = await handler.handle({ operation: 'create', name: 'Proj', workspaceName: 'Dev' } as any);

    expect(ctx.workspaceResolver.resolveWorkspace).toHaveBeenCalled();
    expect(ctx.motionService.createProject).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Proj',
      workspaceId: 'w1',
    }));
    expect(ctx.motionService.createProject.mock.calls[0][0]).not.toHaveProperty('workspaceName');

    const text = (res.content?.[0] as any)?.text || '';
    expect(text).toContain('Successfully created project');
  });

  it('lists projects and includes workspace name in text', async () => {
    const ctx = makeContext();
    const handler = new ProjectHandler(ctx);
    const res = await handler.handle({ operation: 'list', workspaceName: 'Dev' } as any);
    expect(ctx.motionService.getProjects).toHaveBeenCalledWith('w1');
    const text = (res.content?.[0] as any)?.text || '';
    expect(text).toContain('Found 2 projects in workspace "Dev"');
    expect(text).toContain('(ID: p1)');
    expect(text).toContain('(ID: p2)');
  });

  it('gets project details with populated fields', async () => {
    const ctx = makeContext();
    const handler = new ProjectHandler(ctx);
    const res = await handler.handle({ operation: 'get', projectId: 'p1' } as any);

    expect(ctx.motionService.getProject).toHaveBeenCalledWith('p1');
    const text = (res.content?.[0] as any)?.text || '';
    expect(text).toContain('Project details for "A" Details:');
    expect(text).toContain('- Id: p1');
    expect(text).toContain('- Name: A');
    expect(text).toContain('- WorkspaceId: w1');
  });

  it('get still returns ProjectDefinitionId and the full Stages array', async () => {
    const stages = [
      { stageDefinitionId: 'std_1', dueDate: '2026-11-01T23:59:59.000Z', variableInstances: [{ variableName: 'Lead', value: 'usr_1' }] },
      { stageDefinitionId: 'std_2', dueDate: '2026-12-01T23:59:59.000Z' },
    ];
    const ctx = makeContext();
    ctx.motionService.getProject = vi.fn().mockResolvedValue({
      id: 'p1', name: 'A', description: '', workspaceId: 'w1', projectDefinitionId: 'pde_1', stages,
    });
    const handler = new ProjectHandler(ctx);
    const res = await handler.handle({ operation: 'get', projectId: 'p1' } as any);
    const text = (res.content?.[0] as any)?.text || '';
    expect(text).toContain('- ProjectDefinitionId: pde_1');
    expect(text).toContain(`- Stages: ${JSON.stringify(stages)}`);
  });

  describe('create from template', () => {
    const scheduleContext = () => {
      const ctx = makeContext();
      ctx.motionService.getSchedules = vi.fn().mockResolvedValue([]);
      return ctx;
    };

    it('passes projectDefinitionId, stages, dueDate, and priority through', async () => {
      const ctx = scheduleContext();
      const handler = new ProjectHandler(ctx);
      const res = await handler.handle({
        operation: 'create',
        name: 'Proj',
        workspaceId: 'w1',
        dueDate: '2026-12-31',
        priority: 'HIGH',
        projectDefinitionId: 'pde_1',
        stages: [
          { stageDefinitionId: 'std_1', dueDate: '2026-11-01', variableInstances: [{ variableName: 'Lead', value: 'usr_1' }] },
          { stageDefinitionId: 'std_2', dueDate: '2026-12-31T17:00:00-05:00' },
        ],
      } as any);

      expect(res.isError).toBeFalsy();
      const payload = ctx.motionService.createProject.mock.calls[0][0];
      expect(payload).toMatchObject({
        name: 'Proj',
        workspaceId: 'w1',
        priority: 'HIGH',
        projectDefinitionId: 'pde_1',
        dueDate: '2026-12-31T23:59:59.000Z',
      });
      expect(payload.stages).toEqual([
        { stageDefinitionId: 'std_1', dueDate: '2026-11-01T23:59:59.000Z', variableInstances: [{ variableName: 'Lead', value: 'usr_1' }] },
        { stageDefinitionId: 'std_2', dueDate: '2026-12-31T17:00:00-05:00' },
      ]);
      const text = (res.content?.[0] as any)?.text || '';
      expect(text).toContain('from template pde_1 with 2 stage(s)');
    });

    it('does not look up the timezone or send template fields for a plain create', async () => {
      const ctx = scheduleContext();
      const handler = new ProjectHandler(ctx);
      await handler.handle({ operation: 'create', name: 'Proj', workspaceId: 'w1' } as any);
      expect(ctx.motionService.getSchedules).not.toHaveBeenCalled();
      const payload = ctx.motionService.createProject.mock.calls[0][0];
      expect(payload.projectDefinitionId).toBeUndefined();
      expect(payload.stages).toBeUndefined();
    });

    it('rejects projectDefinitionId without stages', async () => {
      const ctx = scheduleContext();
      const res = await new ProjectHandler(ctx).handle({
        operation: 'create', name: 'Proj', workspaceId: 'w1', projectDefinitionId: 'pde_1',
      } as any);
      expect(res.isError).toBe(true);
      expect((res.content?.[0] as any)?.text).toContain('stages is required when projectDefinitionId is provided');
      expect(ctx.motionService.createProject).not.toHaveBeenCalled();
    });

    it('rejects stages without projectDefinitionId', async () => {
      const ctx = scheduleContext();
      const res = await new ProjectHandler(ctx).handle({
        operation: 'create', name: 'Proj', workspaceId: 'w1',
        stages: [{ stageDefinitionId: 'std_1', dueDate: '2026-11-01' }],
      } as any);
      expect(res.isError).toBe(true);
      expect((res.content?.[0] as any)?.text).toContain('stages can only be used together with projectDefinitionId');
      expect(ctx.motionService.createProject).not.toHaveBeenCalled();
    });

    it('rejects a stage missing its dueDate', async () => {
      const ctx = scheduleContext();
      const res = await new ProjectHandler(ctx).handle({
        operation: 'create', name: 'Proj', workspaceId: 'w1', projectDefinitionId: 'pde_1',
        stages: [{ stageDefinitionId: 'std_1', dueDate: '2026-11-01' }, { stageDefinitionId: 'std_2' }],
      } as any);
      expect(res.isError).toBe(true);
      expect((res.content?.[0] as any)?.text).toContain('Stage at index 1 is missing stageDefinitionId or dueDate');
    });

    it('rejects an invalid priority', async () => {
      const ctx = scheduleContext();
      const res = await new ProjectHandler(ctx).handle({
        operation: 'create', name: 'Proj', workspaceId: 'w1', priority: 'URGENT',
      } as any);
      expect(res.isError).toBe(true);
      expect((res.content?.[0] as any)?.text).toContain('Invalid priority "URGENT"');
    });
  });
});
