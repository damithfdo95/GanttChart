/**
 * The JQL the import dialogs prefill (a placeholder project key the SV
 * replaces). Pure constant: newest issues first, capped by the client's
 * paging on the search path.
 */
export const JIRA_JQL_PLACEHOLDER = 'project = XXX ORDER BY updated DESC';