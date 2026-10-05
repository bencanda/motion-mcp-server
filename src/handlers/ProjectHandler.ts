import { BaseHandler } from './base/BaseHandler';
import { McpToolResponse } from '../types/mcp';
import { MotionProjectsArgs } from '../types/mcp-tool-args';
import { MotionProjectStage } from '../types/motion';
import {
  formatMcpSuccess,
  parseProjectArgs,
  formatProjectList,
  formatDetailResponse
} from '../utils';
import { normalizeDueDateForApi } from '../utils/parameterUtils';
import { resolveDisplayTimeZone } from '../utils/dateFormat';
import { isValidPriority, ValidPriority, LOG_LEVELS } from '../utils/constants';
import { mcpLog } from '../utils/logger';

interface CreateProjectParams {
  name?: string;
  workspaceId?: string;
  workspaceName?: string;
  description?: string;
  dueDate?: string;
  priority?: string;
  projectDefinitionId?: string;
  stages?: MotionProjectStage[];
}

interface ListProjectParams {
  workspaceId?: string;
  workspaceName?: string;
  allWorkspaces?: boolean;
}

interface GetProjectParams {
  projectId?: string;
}

export class ProjectHandler extends BaseHandler {
  async handle(args: MotionProjectsArgs): Promise<McpToolResponse> {
    try {
      const { operation, ...params } = args;

      switch(operation) {
        case 'create':
          return await this.handleCreate(params as CreateProjectParams);
        case 'list':
          return await this.handleList(params as ListProjectParams);
        case 'get':
          return await this.handleGet(params as GetProjectParams);
        default:
          return this.handleUnknownOperation(operation);
      }
    } catch (error: unknown) {
      return this.handleError(error);
    }
  }

  private async handleCreate(params: CreateProjectParams): Promise<McpToolResponse> {
    if (!params.name) {
      return this.handleError(new Error("Project name is required for create operation"));
    }

    if (params.priority && !isValidPriority(params.priority)) {
      return this.handleError(new Error(
        `Invalid priority "${params.priority}". Valid values are: ASAP, HIGH, MEDIUM, LOW`
      ));
    }

    const hasStages = params.stages !== undefined;
    if (params.projectDefinitionId && (!hasStages || params.stages!.length === 0)) {
      return this.handleError(new Error(
        "stages is required when projectDefinitionId is provided: pass one { stageDefinitionId, dueDate } entry per template stage, in the template's order. Use the get operation on an existing project from this template to read its Stages."
      ));
    }
    if (hasStages && !params.projectDefinitionId) {
      return this.handleError(new Error("stages can only be used together with projectDefinitionId"));
    }
    const invalidStageIndex = (params.stages ?? []).findIndex(
      stage => !stage?.stageDefinitionId || !stage?.dueDate
    );
    if (invalidStageIndex !== -1) {
      return this.handleError(new Error(
        `Stage at index ${invalidStageIndex} is missing stageDefinitionId or dueDate`
      ));
    }

    const projectData = parseProjectArgs(params as unknown as Record<string, unknown>);
    const workspace = await this.workspaceResolver.resolveWorkspace({
      workspaceId: projectData.workspaceId,
      workspaceName: projectData.workspaceName
    });

    // Date-only and relative due dates resolve against the account's schedule zone,
    // matching how motion_tasks handles dueDate. Only looked up when a date is given.
    const timeZone = (params.dueDate || hasStages) ? await this.resolveTimeZone() : undefined;

    const stages = params.stages?.map(stage => ({
      stageDefinitionId: stage.stageDefinitionId,
      dueDate: normalizeDueDateForApi(stage.dueDate, timeZone) ?? stage.dueDate,
      ...(stage.variableInstances ? { variableInstances: stage.variableInstances } : {})
    }));

    const project = await this.motionService.createProject({
      name: projectData.name,
      description: projectData.description,
      workspaceId: workspace.id,
      dueDate: normalizeDueDateForApi(params.dueDate, timeZone),
      priority: params.priority as ValidPriority | undefined,
      projectDefinitionId: params.projectDefinitionId,
      stages
    });

    const stageInfo = stages ? ` from template ${params.projectDefinitionId} with ${stages.length} stage(s)` : '';
    return formatMcpSuccess(`Successfully created project "${project.name}" (ID: ${project.id})${stageInfo}`);
  }

  private async resolveTimeZone(): Promise<string | undefined> {
    try {
      return resolveDisplayTimeZone(await this.motionService.getSchedules());
    } catch (error) {
      mcpLog(LOG_LEVELS.WARN, 'Timezone resolution failed, project due dates fall back to UTC', {
        error: error instanceof Error ? error.message : String(error)
      });
      return undefined;
    }
  }

  private async handleList(params: ListProjectParams): Promise<McpToolResponse> {
    // If allWorkspaces is true and no specific workspace is provided, list all projects
    if (params.allWorkspaces && !params.workspaceId && !params.workspaceName) {
      const { items: allProjects, truncation } = await this.motionService.getAllProjects();
      return formatProjectList(allProjects, 'All Workspaces', null, { truncation });
    }

    // Otherwise, use the existing single-workspace logic
    const workspace = await this.workspaceResolver.resolveWorkspace({
      workspaceId: params.workspaceId,
      workspaceName: params.workspaceName
    });

    const { items: projects, truncation } = await this.motionService.getProjects(workspace.id);
    return formatProjectList(projects, workspace.name, null, { truncation });
  }

  private async handleGet(params: GetProjectParams): Promise<McpToolResponse> {
    if (!params.projectId) {
      return this.handleError(new Error("Project ID is required for get operation"));
    }

    const projectDetails = await this.motionService.getProject(params.projectId);
    return formatDetailResponse(projectDetails, `Project details for "${projectDetails.name}"`);
  }
}
