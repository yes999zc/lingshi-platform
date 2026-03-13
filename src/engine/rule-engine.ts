import fs from "node:fs";
import path from "node:path";

/**
 * Rule Engine - Central configuration loader and validator
 * Loads config/rules.json and provides type-safe access to all rules
 */

export interface RulesConfig {
  _meta: {
    version: string;
    schema_date: string;
    description: string;
  };
  task: {
    bid_window_seconds: number;
    max_bid_window_seconds: number;
    min_reward_pool_lingshi: number;
    max_reward_pool_lingshi: number;
    auto_cancel_no_bid_seconds: number;
    max_submission_size_bytes: number;
    max_concurrent_open_tasks_per_agent: number;
  };
  bidding: {
    min_bid_amount_lingshi: number;
    bid_escrow_pct: number;
    max_bid_retraction_per_day: number;
    bid_lock_seconds_before_close: number;
  };
  scoring: {
    min_score: number;
    max_score: number;
    pass_threshold: number;
    scorer_commission_pct: number;
    scoring_window_seconds: number;
    require_scorer_isolation: boolean;
  };
  economy: {
    platform_fee_pct: number;
    initial_agent_balance_lingshi: number;
    min_agent_balance_to_post_task_lingshi: number;
    max_daily_mint_per_agent_lingshi: number;
    total_supply_cap_lingshi: number;
  };
  tier: {
    cycle_seconds: number;
    tiers: {
      [tierName: string]: {
        min_lingshi: number;
        min_tasks_completed: number;
        bid_priority_weight: number;
      };
    };
    demotion_grace_cycles: number;
    evaluation_idempotency: boolean;
  };
  anti_abuse: {
    max_concurrent_bids: number;
    max_withdrawal_rate_per_hour: number;
    api_rate_limit_per_minute: number;
    api_burst_limit: number;
    block_same_ip_bids_on_task: boolean;
    auto_suspend_on_abuse: boolean;
    suspension_duration_hours: number;
    max_failed_auth_attempts: number;
    failed_auth_lockout_minutes: number;
  };
  settlement: {
    idempotency_key_algo: string;
    idempotency_key_format: string;
    settlement_timeout_seconds: number;
    allow_partial_settlement: boolean;
  };
  events: {
    retention_days: number;
    max_events_per_query: number;
    types: string[];
  };
  websocket: {
    ping_interval_seconds: number;
    ping_timeout_seconds: number;
    max_connections_per_agent: number;
    max_missed_events_replay: number;
  };
}

export interface RuleValidationResult {
  valid: boolean;
  errors: string[];
}

export class RuleEngine {
  private config: RulesConfig | null = null;
  private configPath: string;
  private watcher: fs.FSWatcher | null = null;

  constructor(configPath?: string) {
    this.configPath = configPath ?? path.resolve(process.cwd(), "config", "rules.json");
  }

  /**
   * Load and validate rules configuration
   */
  load(): RuleValidationResult {
    try {
      const rawConfig = fs.readFileSync(this.configPath, "utf8");
      const parsed = JSON.parse(rawConfig);

      const validation = this.validateConfig(parsed);
      if (!validation.valid) {
        return validation;
      }

      this.config = parsed as RulesConfig;
      return { valid: true, errors: [] };
    } catch (error) {
      return {
        valid: false,
        errors: [`Failed to load config: ${error instanceof Error ? error.message : String(error)}`]
      };
    }
  }

  /**
   * Validate configuration structure and values
   */
  private validateConfig(config: unknown): RuleValidationResult {
    const errors: string[] = [];

    if (!config || typeof config !== "object") {
      return { valid: false, errors: ["Config must be an object"] };
    }

    const c = config as Record<string, unknown>;

    if (!c._meta || typeof c._meta !== "object") {
      errors.push("Missing or invalid _meta section");
    }

    if (!c.task || typeof c.task !== "object") {
      errors.push("Missing or invalid task section");
    }

    if (!c.scoring || typeof c.scoring !== "object") {
      errors.push("Missing or invalid scoring section");
    }

    if (!c.economy || typeof c.economy !== "object") {
      errors.push("Missing or invalid economy section");
    }

    if (!c.tier || typeof c.tier !== "object") {
      errors.push("Missing or invalid tier section");
    }

    if (!c.anti_abuse || typeof c.anti_abuse !== "object") {
      errors.push("Missing or invalid anti_abuse section");
    }

    if (!c.settlement || typeof c.settlement !== "object") {
      errors.push("Missing or invalid settlement section");
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Get the full configuration
   */
  getConfig(): RulesConfig {
    if (!this.config) {
      throw new Error("Rules not loaded. Call load() first.");
    }
    return this.config;
  }

  /**
   * Get a specific rule value by path
   */
  getRule<T = unknown>(section: keyof Omit<RulesConfig, "_meta">, key: string): T {
    if (!this.config) {
      throw new Error("Rules not loaded. Call load() first.");
    }

    const sectionData = this.config[section];
    if (!sectionData || typeof sectionData !== "object") {
      throw new Error(`Invalid section: ${String(section)}`);
    }

    const value = (sectionData as Record<string, unknown>)[key];
    if (value === undefined) {
      throw new Error(`Rule not found: ${String(section)}.${key}`);
    }

    return value as T;
  }

  /**
   * Watch for configuration changes and reload
   */
  watch(onChange?: (config: RulesConfig) => void): void {
    if (this.watcher) {
      return;
    }

    this.watcher = fs.watch(this.configPath, (eventType) => {
      if (eventType === "change") {
        const result = this.load();
        if (result.valid && this.config && onChange) {
          onChange(this.config);
        }
      }
    });
  }

  /**
   * Stop watching for configuration changes
   */
  unwatch(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }
}

// Singleton instance
let ruleEngineInstance: RuleEngine | null = null;

/**
 * Get or create the global rule engine instance
 */
export function getRuleEngine(configPath?: string): RuleEngine {
  if (!ruleEngineInstance) {
    ruleEngineInstance = new RuleEngine(configPath);
  }
  return ruleEngineInstance;
}

/**
 * Initialize and load rules (convenience function)
 */
export function initializeRules(configPath?: string): RuleValidationResult {
  const engine = getRuleEngine(configPath);
  return engine.load();
}

