import { useCallback } from 'preact/hooks';
import { useLocation, useSearch } from 'wouter-preact';

const ALL_AGENTS = 'all';

/** Keep an agent picker synchronized with the page's `agent` query parameter. */
export function useAgentQuery(): readonly [string, (agentId: string) => void] {
  const [pathname, navigate] = useLocation();
  const search = useSearch();
  const agentId = new URLSearchParams(search).get('agent')?.trim() || ALL_AGENTS;

  const setAgentId = useCallback((nextAgentId: string) => {
    const params = new URLSearchParams(search);
    if (!nextAgentId || nextAgentId === ALL_AGENTS) params.delete('agent');
    else params.set('agent', nextAgentId);

    const nextSearch = params.toString();
    navigate(`${pathname}${nextSearch ? `?${nextSearch}` : ''}`);
  }, [navigate, pathname, search]);

  return [agentId, setAgentId] as const;
}
