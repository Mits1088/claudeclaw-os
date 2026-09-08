/** Control turns assess persisted evidence. Execution belongs to bounded worker assignments. */
export const missionCoordinatorToolPolicy = {
  allowedTools: [
    'ToolSearch',
    ...['mission_transition', 'mission_result', 'mission_workflow_result', 'mission_workflow_list']
      .flatMap(name => [`mcp__claudeclaw__${name}`, `mcp__claudeclaw-dispatch__${name}`]),
  ],
  disallowedTools: [
    'Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Agent', 'Task', 'Workflow',
    'WebSearch', 'WebFetch',
    ...['mission_create', 'mission_gather', 'mission_continue', 'mission_handback', 'mission_workflow_create']
      .flatMap(name => [`mcp__claudeclaw__${name}`, `mcp__claudeclaw-dispatch__${name}`]),
  ],
};
