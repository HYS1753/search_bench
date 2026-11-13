// 백엔드 응답 타입 (app/api/common.py 직렬화와 맞춘다)

export type Provider = "vertex" | "gemini" | "anthropic" | "openai" | "openai_compatible";

export interface ProviderMeta {
  label: string;
  needs: string[];
  secret_label: string;
  secret_optional: boolean;
  model_placeholder: string;
  help: string;
  env_secret: string;
}

export interface JudgeModel {
  id: number;
  name: string;
  provider: Provider;
  model: string;
  base_url: string;
  project: string;
  location: string;
  has_secret: boolean;
  secret_hint: string;
  secret_env: string;
  params: { temperature?: number | null; max_tokens?: number };
  price_input_per_mtok: number;
  price_output_per_mtok: number;
  is_default: boolean;
  last_test_ok: boolean | null;
  last_test_message: string;
  last_tested_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ParamSpec {
  name: string;
  source: "field" | "const";
  field: string;
  value: string;
  location: "query" | "body" | "path";
  array_style: "" | "repeat" | "space" | "comma" | "json";
  example: string;
  json_type?: "" | "string" | "number" | "boolean";
  label?: string;
  required?: boolean;
}

export interface TextFieldSpec {
  label: string;
  path: string;
}

export interface ResponseMapping {
  results_path: string;
  id_path: string;
  title_path: string;
  score_path: string;
  text_fields: TextFieldSpec[];
}

export interface AuthSpec {
  type: "none" | "bearer" | "header" | "query";
  name: string;
  env: string;
}

export interface Target {
  id: number;
  name: string;
  description: string;
  method: "GET" | "POST";
  base_url: string;
  path: string;
  headers: Record<string, string>;
  auth: AuthSpec;
  has_secret: boolean;
  secret_hint: string;
  params: ParamSpec[];
  response_mapping: ResponseMapping;
  timeout_seconds: number | null;
  verify_ssl: boolean;
  created_at: string;
  updated_at: string;
}

export interface InputField {
  key: string;
  label: string;
  type: "text" | "list" | "int";
  required: boolean;
  default: unknown;
  help: string;
  scope?: string; // "" = 모든 API 공통, 아니면 그 입력을 쓰는 API 라벨
}

export type Transform = "as_is" | "join_space" | "join_comma" | "split" | "first" | "number" | "const" | "template";
export interface Binding {
  from: string;
  transform: Transform;
  value: string;
}
export interface MatchRule {
  lower: boolean;
  digits_only: boolean;
  strip_prefix: string;
  strip_suffix: string;
}
export interface SuiteMember {
  target_id: number;
  label: string;
  position: number;
  is_baseline: boolean;
  target_name: string;
  input_bindings: Record<string, Binding>;
  match: Partial<MatchRule>;
  criteria_id?: number | null;
}

export interface Suite {
  id: number;
  name: string;
  description: string;
  input_fields: InputField[];
  default_criteria_id: number | null;
  match_mode: "id" | "title" | "none";
  members: SuiteMember[];
  dataset_count?: number;
  created_at: string;
  updated_at: string;
}

export interface Criteria {
  id: number;
  name: string;
  description: string;
  task_context: string;
  user_requirements: string;
  k: number;
  relevant_threshold: number;
  pairwise_enabled: boolean;
  system_prompt?: string;
  item_template?: string;
  pairwise_template?: string;
  created_at: string;
  updated_at: string;
}

export interface Dataset {
  id: number;
  name: string;
  description: string;
  columns: string[];
  source_filename: string;
  row_count: number;
  created_at: string;
  updated_at: string;
  rows?: Record<string, unknown>[];
  suite_id?: number | null;
  suite_name?: string | null;
  mapping?: Partial<Mapping>;
  meta?: { source?: "file" | "manual" | "paste" | "llm" | "compare"; grounded?: boolean; model?: string; [k: string]: unknown };
  compat?: Compat;
  version?: number;
}

export interface Compat {
  status: "ready" | "check" | "missing" | "unbound";
  mapping: Mapping & { saved: boolean; matched_by: Record<string, "exact" | "similar" | "saved"> };
  missing_required: string[];
  unmapped_optional: string[];
  similar: string[];
  unused_columns: string[];
  bound: boolean;
  suite_id?: number;
  suite_name?: string;
}

export interface Item {
  key: string;
  title: string;
  fields: { label: string; value: string }[];
  score: number | null;
}

export interface Judgment {
  grade: number;
  reason: string;
}

export interface CaseMetric {
  ndcg: number | null;
  hit1: number | null;
  mrr: number | null;
  precision: number | null;
  top1_grade: number | null;
  ok: boolean;
  latency_ms: number | null;
  empty: boolean;
}

export interface PairwiseOrder {
  order: string;
  winner: "candidate" | "baseline" | "tie";
  confidence: string | null;
  reason: string;
}

export interface Pairwise {
  winner: "candidate" | "baseline" | "tie";
  consistent: boolean;
  auto: boolean;
  reason: string;
  orders: PairwiseOrder[];
}

export interface Verdict {
  code: "improved" | "regressed" | "no_difference" | "inconclusive" | "no_data";
  title: string;
  detail: string;
  /** 결론은 냈지만 케이스가 권장(30건)보다 적음 */
  weak?: boolean;
}

export interface TargetSummary {
  label: string;
  is_baseline: boolean;
  cases: number;
  ndcg: number | null;
  hit1: number | null;
  mrr: number | null;
  precision: number | null;
  error_rate: number | null;
  empty_rate: number | null;
  latency_p50: number | null;
  latency_p95: number | null;
}

export interface Comparison {
  candidate: string;
  baseline: string;
  baseline_ndcg?: number | null;
  hit1_ci?: [number, number] | null;
  permutation_p?: number | null;
  permutation_p_holm?: number | null;
  multiple_comparisons?: number;
  effect_size?: number | null;
  needed_cases?: number | null;
  ndcg_sd?: number | null;
  win_rate_ci?: [number, number] | null;
  win_rate_with_ties?: number | null;
  baseline_hit1?: number | null;
  criteria?: { id: number; name: string; k: number };
  ndcg_cases: number;
  ndcg_diff: number | null;
  ndcg_ci: [number, number] | null;
  hit1_diff: number | null;
  improved_cases: number;
  regressed_cases: number;
  same_cases: number;
  pairwise_cases: number;
  wins: number;
  losses: number;
  ties: number;
  inconsistent: number;
  win_rate: number | null;
  sign_test_p: number | null;
  verdict: Verdict;
}

export interface CategorySummary {
  category: string;
  cases: number;
  ndcg: Record<string, number>;
  wins: Record<string, number>;
  losses: Record<string, number>;
}

export interface RunSummary {
  baseline?: string;
  cases?: number;
  no_relevant_cases?: number;
  warnings?: string[];
  grade_distribution?: Record<string, { items: Record<string, number>; top1: Record<string, number> }>;
  targets?: TargetSummary[];
  comparisons?: Comparison[];
  by_category?: CategorySummary[];
  status_counts?: Record<string, number>;
  /** 사람 판정 */
  review?: ReviewProgress;
  agreement?: Agreement;
  inter_rater?: InterRater;
  reviewers?: ReviewerStat[];
  human?: RunSummary;
  combined?: RunSummary;
}

export interface ReviewProgress {
  done_cases: number;
  reviewed_cases: number;
  complete_cases: number;
  pairwise_cases: number;
  items_graded: number;
  reviewers?: number;
}

export interface InterRater {
  pairs: { a: string; b: string; items: number; kappa: number | null; exact: number }[];
  kappa_avg: number | null;
  items: number;
  pairwise_agree: number | null;
  pairwise_items: number;
}
export interface ReviewerStat {
  reviewer: string;
  cases: number;
  items: number;
  kappa_llm: number | null;
  bias_llm: number | null;
  exact_llm: number | null;
}

export interface Agreement {
  items: number;
  exact: number | null;
  within1: number | null;
  kappa_quadratic: number | null;
  kappa_binary: number | null;
  binary_agree: number | null;
  bias: number | null;
  llm_mean: number | null;
  human_mean: number | null;
  confusion: number[][];
  pairwise_cases: number;
  pairwise_agree: number | null;
}

export interface HumanJudgment {
  grade: number;
  note?: string;
  at?: string;
}

export type RunStatus = "queued" | "running" | "done" | "failed" | "cancelled" | "interrupted";

export interface Run {
  id: number;
  name: string;
  status: RunStatus;
  suite_id: number | null;
  dataset_id: number | null;
  judge_model_id: number | null;
  suite_name: string | null;
  dataset_name: string | null;
  judge_model: { id: number; name: string; provider: string; model: string } | null;
  criteria: Criteria | null;
  criteria_by_member?: Record<string, Criteria>;
  dataset_version?: number | null;
  members: { label: string; is_baseline: boolean; target_name: string }[];
  input_fields: InputField[];
  mapping: Mapping | null;
  options: { concurrency?: number; fetch_limit?: number; judge_batch_size?: number };
  total: number;
  completed: number;
  failed: number;
  judge_calls: number;
  tokens_input: number;
  tokens_output: number;
  cost_estimate: number;
  error: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  summary?: RunSummary;
  is_live?: boolean;
  headline?: {
    verdict: Verdict | null;
    ndcg_diff: number | null;
    wins: number | null;
    losses: number | null;
    ties: number | null;
    candidate: string | null;
  };
}

export interface Mapping {
  fields: Record<string, string>;
  case_key: string;
  category: string;
  expected: string;
}

export interface CaseTop {
  ok: boolean | null;
  error: string;
  title: string | null;
  grade: number | null;
  latency_ms: number | null;
  count: number;
}

export interface CaseRow {
  id: number;
  row_index: number;
  case_key: string;
  category: string;
  inputs: Record<string, unknown>;
  expected: string;
  status: "pending" | "done" | "error";
  error: string;
  metrics: Record<string, CaseMetric>;
  pairwise: Record<string, Pairwise>;
  tops: Record<string, CaseTop>;
  ndcg_diff: number | null;
}

export interface CaseDetail {
  id: number;
  row_index: number;
  case_key: string;
  category: string;
  inputs: Record<string, unknown>;
  expected: string;
  status: string;
  error: string;
  metrics: Record<string, CaseMetric>;
  pairwise: Record<string, Pairwise>;
  item_judgments: Record<string, Judgment>;
  human_judgments?: Record<string, HumanJudgment>;
  human_pairwise?: Record<string, "candidate" | "baseline" | "tie">;
  human_by?: Record<string, { grades?: Record<string, HumanJudgment>; pairwise?: Record<string, "candidate" | "baseline" | "tie"> }>;
  responses: {
    label: string;
    ok: boolean;
    status_code: number | null;
    latency_ms: number;
    error: string;
    items: Item[];
    raw: unknown;
  }[];
}

export interface CompareSide {
  label: string;
  is_baseline: boolean;
  target_name: string;
  ok: boolean;
  status_code: number | null;
  latency_ms: number;
  error: string;
  items: Item[];
  request: Record<string, unknown>;
  raw: unknown;
}

export interface CompareResult {
  inputs: Record<string, unknown>;
  sides: CompareSide[];
  evaluation:
    | null
    | { ok: false; error: string }
    | {
        ok: true;
        item_judgments: Record<string, Judgment>;
        metrics: Record<string, CaseMetric>;
        pairwise: Record<string, Pairwise>;
        tokens_input: number;
        tokens_output: number;
        judge_calls: number;
        cost_estimate: number;
        judge_model: { id: number; name: string; model: string };
        criteria: { id: number; name: string; k: number } | null;
      };
}

export interface ActiveRun {
  id: number;
  name: string;
  status: RunStatus;
  total: number;
  completed: number;
  failed: number;
}

export interface Overview {
  counts: Record<string, number>;
  onboarding: { key: string; title: string; done: boolean; hint: string; to: string }[];
  active: { id: number; name: string; status: RunStatus; total: number; completed: number }[];
  recent: Run[];
  trend: { id: number; name: string; suite: string; finished_at: string; ndcg_diff: number; win_rate: number | null }[];
  month: { runs: number; cost: number; judge_calls: number };
}

export interface SystemInfo {
  version: string;
  data_dir: string;
  db_size_bytes: number;
  login_required: boolean;
  secret_key_source: string;
  env_keys: Record<string, string>;
  target_defaults: { timeout_seconds: number; verify_ssl: boolean };
  run_defaults: { concurrency: number; judge_timeout_seconds: number; judge_max_retries: number };
  counts: Record<string, number>;
}

export interface CostModel {
  key: string;
  id: number | null;
  name: string;
  provider: string;
  model: string;
  exists: boolean;
  is_default: boolean;
  priced: boolean;
  price_input_per_mtok: number | null;
  price_output_per_mtok: number | null;
  runs: number;
  cases: number;
  judge_calls: number;
  tokens_input: number;
  tokens_output: number;
  cost: number;
  cost_input: number;
  cost_output: number;
  share: number;
  avg_cost_per_case: number | null;
  last_used_at: string | null;
}

export interface CostReport {
  period: "7d" | "30d" | "90d" | "month" | "all";
  since: string;
  until: string;
  totals: {
    cost: number;
    runs: number;
    cases: number;
    judge_calls: number;
    tokens_input: number;
    tokens_output: number;
    avg_cost_per_run: number | null;
    avg_cost_per_case: number | null;
    prev_cost: number | null;
    change: number | null;
  };
  all_time_cost: number;
  models: CostModel[];
  series: string[];
  daily: { date: string; total: number; by_model: Record<string, number> }[];
  top_runs: { id: number; name: string; status: RunStatus; model: string; cases: number; judge_calls: number; cost: number; created_at: string }[];
  unpriced: string[];
}

/** /runs/{id}/details — 후보 vs 기준 상세 지표 */
export interface RunDetails {
  candidate: string;
  baseline: string;
  k: number;
  relevant_threshold: number;
  cases: number;
  overlap: {
    cases: number;
    mean_jaccard: number | null;
    top1_same_rate: number | null;
    identical_rate: number | null;
    hist: number[];
    mean_filled: { baseline: number | null; candidate: number | null };
    short_rate: { baseline: number | null; candidate: number | null };
  };
  grade_by_rank: Record<"baseline" | "candidate", { rank: number; mean: number | null; relevant_rate: number | null; n: number }[]>;
  relevant_found: {
    items: { both: number; baseline_only: number; candidate_only: number };
    cases: { gain: number; same: number; loss: number };
  };
  agreement: {
    matrix: Record<"candidate" | "tie" | "baseline", { up: number; same: number; down: number }>;
    cases: number;
    agree_rate: number | null;
    opposite_rate: number | null;
    confidence: { high: number; medium: number; low: number };
  };
}
