/**
 * Типы для `version-metrics.mjs` (метрики версии ETN, задача 81a9a521).
 * Нужны юнит-тесту `tests/version-metrics.test.ts`, который проверяет чистые
 * функции разбора на снимках реальных хроник и коммитов.
 */

export declare const DEFAULT_NETWORK_ID: string;
export declare const DEFAULT_VERSION_LINK_PROPERTY_ID: string;
export declare const VERSION_TYPE_ID: string;
export declare const WORK_TYPE_IDS: {
  readonly techProject: string;
  readonly error: string;
  readonly task: string;
};

export interface ParsedCommit {
  type: string | null;
  scope: string | null;
  taskIds: string[];
  merge: boolean;
}
export declare function parseCommitSubject(subject: string): ParsedCommit;

export interface CommitSummary {
  total: number;
  fix: number;
  feat: number;
  fixToFeat: number | null;
  byType: Record<string, number>;
}
export declare function summariseCommits(subjects: string[]): CommitSummary;

/** Комментарий мысли (подмножество полей REST-контракта). */
export interface TrendComment {
  kind: string;
  title?: string | null;
  body_md?: string | null;
  valid_from?: string | null;
}
export declare function firstPassAccepted(comments: TrendComment[]): boolean;
export declare function verifierRoundCount(comments: TrendComment[]): number;
export declare function hasUserGuiFinding(text: string, title?: string): boolean;
/** Класс пользовательской GUI-находки: доводка интерфейса или дефект. */
export type UserGuiFindingClass = 'polish' | 'defect';
export declare function classifyUserGuiFinding(text: string, title?: string): UserGuiFindingClass;
export declare const POLISH_MARKERS: readonly RegExp[];
export declare const DEFECT_MARKERS: readonly RegExp[];
export declare function hasRepeatedDelegation(text: string): boolean;

export interface WorkRef {
  id: string;
  title: string;
  type_id: string;
  active: boolean;
  created_at?: string | null;
}
export interface TaskGroup {
  name: string;
  taskIds: string[];
}
export interface GroupFirstPass {
  name: string;
  accepted: number;
  total: number;
  ratio: number | null;
  taskIds: string[];
  notAccepted: { id: string; title: string }[];
}
export interface WorksSummary {
  total: number;
  active: number;
  inactive: number;
  byType: Record<string, number>;
  errors: number;
  userGuiFindings: { total: number; polish: number; defect: number };
  userGuiFindingIds: string[];
  /** Id находок по классам: доводка интерфейса / реальный дефект. */
  userGuiPolishIds: string[];
  userGuiDefectIds: string[];
  repeatedDelegations: number;
  repeatedDelegationIds: string[];
  firstPass: {
    accepted: number;
    total: number;
    ratio: number | null;
    byGroup: GroupFirstPass[];
    ungroupedTasks?: number;
  };
}
export declare function summariseWorks(input: {
  works: WorkRef[];
  commentsById: Record<string, TrendComment[]>;
  groups?: TaskGroup[];
}): WorksSummary;

export declare function orderTags(tags: string[]): string[];
export declare function previousTag(tags: string[], tag: string): string | null;

export interface Duration {
  from: string;
  to: string;
  days: number;
}
export declare function versionDuration(
  createdAt: string | null | undefined,
  publishedDate: string | null | undefined,
  updatedAt: string | null | undefined,
): Duration | null;

export interface McpConfig {
  url: string;
  token: string;
}
export declare function readMcpConfig(text: string | null, serverName?: string): McpConfig | null;

export interface CliOptions {
  specs: string[];
  compare: boolean;
  base: string | null;
  token: string | null;
  config: string | null;
  network: string | null;
  linkProperty: string | null;
  repo: string | null;
  json: string | null;
  noGit: boolean;
  help: boolean;
}
export declare function parseArgs(argv: string[]): CliOptions;

export interface Endpoint {
  base: string;
  apiBase: string;
  token: string;
  networkId: string;
  linkProperty: string;
  repo: string;
  json: string | null;
  noGit: boolean;
}
export declare function resolveEndpoint(deps: {
  argv: string[];
  env: Record<string, string | undefined>;
  readFile: (file: string) => string | null;
  home?: string;
  repoRoot?: string;
}): Endpoint;

export interface VersionReport {
  spec: string;
  number: string;
  versionId: string;
  layerId: string | null;
  published: boolean;
  publishedDate: string | null;
  duration: Duration | null;
  works: WorksSummary;
  commits: CommitSummary | null;
  gitRange: string | null;
}
export declare function formatReport(report: VersionReport): string;
export declare function formatComparison(a: VersionReport, b: VersionReport): string;
