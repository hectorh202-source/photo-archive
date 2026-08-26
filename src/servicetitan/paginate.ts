import { stRequest } from "./httpClient";
import type { ServiceTitanConfig } from "../db/clientSettings";

// ServiceTitan's standard list envelope — every v2 module returns this same
// shape (see callReasons.ts's note), so one walker serves all of them.
export interface PaginatedResponse<T> {
  page?: number;
  pageSize?: number;
  hasMore?: boolean;
  totalCount?: number | null;
  data?: T[];
}

const DEFAULT_PAGE_SIZE = 200;

// Walks every page of a ServiceTitan list endpoint. maxPages is a runaway
// guard, not a real limit anyone should hit: at 200/page it takes 25 pages
// to exceed 5,000 rows of one sub-resource for a *single* job, which would
// mean something is wrong with the query rather than with the job.
export async function fetchAllPages<T>(
  config: ServiceTitanConfig,
  path: string,
  params: Record<string, unknown> = {},
  options: { pageSize?: number; maxPages?: number } = {},
): Promise<T[]> {
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const maxPages = options.maxPages ?? 25;
  const all: T[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const result = await stRequest<PaginatedResponse<T>>(config, "GET", path, {
      params: { ...params, page, pageSize },
    });
    // A few endpoints (jobs/{id}/history) return a bare array instead of the
    // envelope — treat that as a single complete page rather than failing.
    if (Array.isArray(result)) {
      all.push(...(result as T[]));
      return all;
    }
    all.push(...(result.data ?? []));
    if (!result.hasMore) break;
  }
  return all;
}
