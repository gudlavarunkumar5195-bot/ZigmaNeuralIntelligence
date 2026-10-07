const MODELS = {
  haiku: "claude-haiku-4-5",
  sonnet: "claude-sonnet-5-5",
  opus: "claude-opus-5-5",
};

const BUDGET_USD = 25.00;

// Conservative internal thresholds.
// These are routing safeguards, not Anthropic billing limits.
const LIMITS = {
  simple: 0.05,
  normal: 0.25,
  complex: 1.00,
};

function classifyTask(task) {
  const text = task.toLowerCase();

  const complexSignals = [
    "architecture",
    "migration",
    "database redesign",
    "security audit",
    "cross-tenant",
    "authentication redesign",
    "authorization redesign",
    "major refactor",
    "production incident",
    "complex debugging",
    "multi-agent",
    "system-wide",
  ];

  const simpleSignals = [
    "rename",
    "typo",
    "format",
    "simple",
    "small change",
    "text change",
    "copy change",
    "label",
  ];

  if (complexSignals.some(signal => text.includes(signal))) {
    return "complex";
  }

  if (simpleSignals.some(signal => text.includes(signal))) {
    return "simple";
  }

  return "normal";
}

function chooseModel(complexity) {
  return MODELS[
    complexity === "simple"
      ? "haiku"
      : complexity === "complex"
        ? "opus"
        : "sonnet"
  ];
}

function estimateBudget(complexity) {
  return LIMITS[complexity];
}

export function routeTask(task) {
  const complexity = classifyTask(task);
  const model = chooseModel(complexity);
  const estimatedCost = estimateBudget(complexity);

  if (estimatedCost > BUDGET_USD) {
    throw new Error(
      `Budget guard blocked task: estimated cost $${estimatedCost.toFixed(2)} exceeds remaining budget.`
    );
  }

  return {
    complexity,
    model,
    estimatedCostUSD: estimatedCost,
    budgetUSD: BUDGET_USD,
  };
}

// CLI test
if (import.meta.url === `file://${process.argv[1]}`) {
  const task = process.argv.slice(2).join(" ");

  if (!task) {
    console.error('Usage: node .zigma-agent/router.mjs "your task"');
    process.exit(1);
  }

  console.log(JSON.stringify(routeTask(task), null, 2));
}
