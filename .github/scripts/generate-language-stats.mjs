import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const API_ROOT = "https://api.github.com";
const DEFAULT_OUTPUT = "assets/top-langs.svg";
const MAX_LANGUAGES = 12;

const LANGUAGE_COLORS = {
  Assembly: "#6E4C13",
  C: "#555555",
  "C#": "#178600",
  "C++": "#F34B7D",
  Clojure: "#DB5855",
  CSS: "#563D7C",
  Dart: "#00B4AB",
  Dockerfile: "#384D54",
  Elixir: "#6E4A7E",
  Go: "#00ADD8",
  Haskell: "#5E5086",
  HTML: "#E34C26",
  Java: "#B07219",
  JavaScript: "#F1E05A",
  "Jupyter Notebook": "#DA5B0B",
  Kotlin: "#A97BFF",
  Lua: "#51A0CF",
  Makefile: "#427819",
  "Objective-C": "#438EFF",
  Perl: "#0298C3",
  PHP: "#4F5D95",
  PowerShell: "#012456",
  Python: "#3572A5",
  R: "#198CE7",
  Ruby: "#701516",
  Rust: "#DEA584",
  Scala: "#C22D40",
  SCSS: "#C6538C",
  Shell: "#89E051",
  Svelte: "#FF3E00",
  Swift: "#F05138",
  TeX: "#3D6117",
  TypeScript: "#3178C6",
  Vue: "#41B883",
};

const OTHER_COLOR = "#6E7681";
const TECH_COLORS = {
  Java: "#E3B341",
  JavaScript: "#F1E05A",
  LangChain: "#A5D6A7",
  "Next.js": "#E6EDF3",
  React: "#61DAFB",
  Redis: "#FF7A45",
  "Spring AI": "#56D364",
  "Spring Boot": "#56D364",
  "Spring Cloud": "#56D364",
  TypeScript: "#79C0FF",
  Vue: "#56D364",
};

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function apiHeaders(username, token) {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": `${username}-language-stats`,
    "X-GitHub-Api-Version": "2022-11-28",
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  return headers;
}

async function requestJson(url, headers) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(url, { headers });

    if (response.ok) {
      return response.json();
    }

    const retryable = [403, 429, 500, 502, 503, 504].includes(response.status);
    if (!retryable || attempt === 3) {
      const body = await response.text();
      throw new Error(
        `GitHub API returned ${response.status} for ${url}: ${body.slice(0, 300)}`,
      );
    }

    const retryAfter = Number(response.headers.get("retry-after"));
    await sleep(Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : 1000 * 2 ** attempt);
  }

  throw new Error(`GitHub API request failed: ${url}`);
}

async function getPublicRepositories(username, headers) {
  const repositories = [];

  for (let page = 1; page <= 20; page += 1) {
    const url = `${API_ROOT}/users/${encodeURIComponent(username)}/repos`
      + `?type=owner&sort=updated&per_page=100&page=${page}`;
    const batch = await requestJson(url, headers);

    repositories.push(...batch);

    if (batch.length < 100) {
      break;
    }
  }

  return repositories;
}

async function collectLanguageStats(repositories, headers, excludedRepos) {
  const totals = new Map();
  const collectedRepositories = [];
  const includedRepositories = repositories.filter((repository) => {
    return !repository.fork
      && !excludedRepos.has(repository.name.toLowerCase())
      && !excludedRepos.has(repository.full_name.toLowerCase());
  });

  for (let offset = 0; offset < includedRepositories.length; offset += 6) {
    const batch = includedRepositories.slice(offset, offset + 6);

    const collected = await Promise.all(batch.map(async (repository) => {
      const url = `${API_ROOT}/repos/${repository.full_name}/languages`;
      const languages = await requestJson(url, headers);

      return {
        fullName: repository.full_name,
        languages,
        private: repository.private,
      };
    }));

    for (const repository of collected) {
      collectedRepositories.push(repository);

      for (const [language, bytes] of Object.entries(repository.languages)) {
        const current = totals.get(language) ?? { bytes: 0, repositories: 0 };
        totals.set(language, {
          bytes: current.bytes + bytes,
          repositories: current.repositories + 1,
        });
      }
    }
  }

  return {
    repositories: collectedRepositories.sort((left, right) => {
      return left.fullName.localeCompare(right.fullName);
    }),
    totals,
  };
}

function createAuditRecord({
  collection,
  countWeight,
  displayedLanguages,
  excludedLanguages,
  excludedRepos,
  featuredTech,
  languageWeights,
  limit,
  sizeWeight,
  username,
}) {
  return {
    generatedAt: new Date().toISOString(),
    username,
    configuration: {
      countWeight,
      excludedLanguages: [...excludedLanguages],
      excludedRepositories: [...excludedRepos],
      featuredStack: featuredTech,
      languageWeights: Object.fromEntries(languageWeights),
      languagesCount: limit,
      sizeWeight,
    },
    repositories: collection.repositories,
    rawLanguageTotals: Object.fromEntries(collection.totals),
    displayedLanguages: displayedLanguages.map((language) => ({
      name: language.name,
      percent: Number(language.percent.toFixed(4)),
    })),
  };
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function normalizeWeights(sizeWeight, countWeight) {
  const safeSizeWeight = Number.isFinite(sizeWeight)
    ? Math.max(0, Math.min(1, sizeWeight))
    : 0.5;
  const safeCountWeight = Number.isFinite(countWeight)
    ? Math.max(0, Math.min(1, countWeight))
    : 0.5;
  const total = safeSizeWeight + safeCountWeight;

  if (total === 0) {
    return { sizeWeight: 1, countWeight: 0 };
  }

  return {
    sizeWeight: safeSizeWeight / total,
    countWeight: safeCountWeight / total,
  };
}

export function buildLanguageRows(
  languageTotals,
  limit,
  sizeWeight,
  countWeight,
  languageWeights,
  excludedLanguages,
) {
  const languages = [...languageTotals.entries()]
    .filter(([name, stats]) => {
      return stats.bytes > 0 && !excludedLanguages.has(name.toLowerCase());
    });
  const totalBytes = languages.reduce((sum, [, stats]) => sum + stats.bytes, 0);
  const totalRepositoryUses = languages.reduce(
    (sum, [, stats]) => sum + stats.repositories,
    0,
  );

  if (totalBytes === 0) {
    return [];
  }

  const weights = normalizeWeights(sizeWeight, countWeight);
  const scoredLanguages = languages.map(([name, stats]) => {
    const baseScore = weights.sizeWeight * (stats.bytes / totalBytes)
      + weights.countWeight * (stats.repositories / totalRepositoryUses);
    const languageWeight = languageWeights.get(name.toLowerCase()) ?? 1;

    return {
      name,
      score: baseScore * languageWeight,
    };
  });
  const weightedScoreTotal = scoredLanguages.reduce(
    (sum, language) => sum + language.score,
    0,
  );
  const normalizedLanguages = scoredLanguages.map((language) => ({
    name: language.name,
    score: language.score / weightedScoreTotal,
  }))
    .sort((left, right) => right.score - left.score);
  const topLanguages = normalizedLanguages.slice(0, limit);
  const otherScore = normalizedLanguages
    .slice(limit)
    .reduce((sum, language) => sum + language.score, 0);

  if (otherScore > 0) {
    topLanguages.push({ name: "Other", score: otherScore });
  }

  return topLanguages.map(({ name, score }, index) => ({
    color: name === "Other"
      ? OTHER_COLOR
      : (LANGUAGE_COLORS[name] ?? `hsl(${index * 47} 55% 52%)`),
    name,
    percent: score * 100,
  }));
}

export function renderLanguageSvg(
  languageTotals,
  limit = MAX_LANGUAGES,
  sizeWeight = 1,
  countWeight = 0,
  featuredTech = ["Spring Cloud", "Spring AI", "Vue", "React", "LangChain"],
  languageWeights = new Map(),
  excludedLanguages = new Set(),
) {
  const rows = buildLanguageRows(
    languageTotals,
    limit,
    sizeWeight,
    countWeight,
    languageWeights,
    excludedLanguages,
  );
  const width = 495;
  const barX = 25;
  const barY = 24;
  const barWidth = width - barX * 2;
  const barHeight = 10;
  const columnWidth = 222;
  const legendStartY = 63;
  const rowHeight = 24;
  const rowsPerColumn = Math.ceil(rows.length / 2);
  const dividerY = legendStartY + (rowsPerColumn - 1) * rowHeight + 24;
  const stackLabelY = dividerY + 24;
  const stackPillY = dividerY + 35;
  const stackPillHeight = 26;
  const height = featuredTech.length > 0
    ? Math.max(180, stackPillY + stackPillHeight + 16)
    : Math.max(180, dividerY + 16);

  if (rows.length === 0) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="90" viewBox="0 0 ${width} 90">
  <rect x="0.5" y="0.5" width="${width - 1}" height="89" rx="6" fill="#0D1117" stroke="#30363D"/>
  <text x="${width / 2}" y="49" fill="#8B949E" text-anchor="middle" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" font-size="13">No public language data found</text>
</svg>`;
  }

  let barOffset = 0;
  const bars = rows.map((row, index) => {
    const remainingWidth = barWidth - barOffset;
    const segmentWidth = index === rows.length - 1
      ? remainingWidth
      : Math.max(0, (row.percent / 100) * barWidth);
    const segment = `<rect x="${(barX + barOffset).toFixed(2)}" y="${barY}" width="${segmentWidth.toFixed(2)}" height="${barHeight}" fill="${row.color}"/>`;
    barOffset += segmentWidth;
    return segment;
  }).join("");

  const legend = rows.map((row, index) => {
    const column = Math.floor(index / rowsPerColumn);
    const rowIndex = index % rowsPerColumn;
    const x = barX + column * columnWidth;
    const y = legendStartY + rowIndex * rowHeight;
    const percent = row.percent.toFixed(2);

    return `<g>
      <circle cx="${x + 4}" cy="${y - 4}" r="4" fill="${row.color}"/>
      <text x="${x + 14}" y="${y}" fill="#C9D1D9" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" font-size="12">${escapeXml(row.name)}</text>
      <text x="${x + columnWidth - 24}" y="${y}" fill="#8B949E" text-anchor="end" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" font-size="12">${percent}%</text>
    </g>`;
  }).join("");

  let stackOffset = 0;
  const featuredStack = featuredTech.map((technology) => {
    const label = String(technology).trim();
    const color = TECH_COLORS[label] ?? "#8B949E";
    const pillWidth = Math.max(56, Math.min(150, label.length * 7 + 24));
    const x = barX + stackOffset;
    const pill = `<g>
      <rect x="${x.toFixed(2)}" y="${stackPillY}" width="${pillWidth}" height="${stackPillHeight}" rx="6" fill="#161B22" stroke="${color}" stroke-opacity="0.7"/>
      <text x="${(x + pillWidth / 2).toFixed(2)}" y="${stackPillY + 17}" fill="${color}" text-anchor="middle" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" font-size="11" font-weight="600">${escapeXml(label)}</text>
    </g>`;
    stackOffset += pillWidth + 8;
    return pill;
  }).join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Most used programming languages">
  <title>GitHub language statistics</title>
  <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="6" fill="#0D1117" stroke="#30363D"/>
  <clipPath id="language-bar"><rect x="${barX}" y="${barY}" width="${barWidth}" height="${barHeight}" rx="5"/></clipPath>
  <g clip-path="url(#language-bar)">${bars}</g>
  ${legend}
  ${featuredTech.length > 0 ? `<line x1="${barX}" y1="${dividerY}" x2="${width - barX}" y2="${dividerY}" stroke="#21262D"/>
  <text x="${barX}" y="${stackLabelY}" fill="#8B949E" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" font-size="10" font-weight="600" letter-spacing="1.2">FEATURED STACK</text>
  ${featuredStack}` : ""}
</svg>
`;
}

async function main() {
  const username = process.env.GH_USERNAME || "ZNNW";
  const token = process.env.GITHUB_TOKEN;
  const output = process.env.OUTPUT || DEFAULT_OUTPUT;
  const auditOutput = process.env.AUDIT_OUTPUT || "assets/language-stats.json";
  const limit = Number(process.env.LANGS_COUNT || MAX_LANGUAGES);
  const sizeWeight = Number(process.env.SIZE_WEIGHT || 1);
  const countWeight = Number(process.env.COUNT_WEIGHT || 0);
  const featuredTech = (
    process.env.FEATURED_TECH
      || "Spring Cloud,Spring AI,Vue,React,LangChain"
  )
    .split(",")
    .map((technology) => technology.trim())
    .filter(Boolean);
  const languageWeights = new Map(
    (process.env.LANGUAGE_WEIGHTS || "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const separator = entry.lastIndexOf(":");
        if (separator === -1) {
          return ["", Number.NaN];
        }

        return [
          entry.slice(0, separator).trim().toLowerCase(),
          Number(entry.slice(separator + 1).trim()),
        ];
      })
      .filter(([language, weight]) => {
        return language && Number.isFinite(weight) && weight > 0;
      }),
  );
  const excludedLanguages = new Set(
    (process.env.EXCLUDE_LANGUAGES || "")
      .split(",")
      .map((language) => language.trim().toLowerCase())
      .filter(Boolean),
  );
  const excludedRepos = new Set(
    (process.env.EXCLUDE_REPOS || "Frontend-learning-lab,js-browser-engineering-lab")
      .split(",")
      .map((repository) => repository.trim().toLowerCase())
      .filter(Boolean),
  );
  const headers = apiHeaders(username, token);

  console.log(`Fetching public repositories for ${username}...`);
  const repositories = await getPublicRepositories(username, headers);
  console.log(`Found ${repositories.length} public repositories.`);

  const collection = await collectLanguageStats(
    repositories,
    headers,
    excludedRepos,
  );
  const languageTotals = collection.totals;
  const svg = renderLanguageSvg(
    languageTotals,
    limit,
    sizeWeight,
    countWeight,
    featuredTech,
    languageWeights,
    excludedLanguages,
  );
  const displayedLanguages = buildLanguageRows(
    languageTotals,
    limit,
    sizeWeight,
    countWeight,
    languageWeights,
    excludedLanguages,
  );
  const audit = createAuditRecord({
    collection,
    countWeight,
    displayedLanguages,
    excludedLanguages,
    excludedRepos,
    featuredTech,
    languageWeights,
    limit,
    sizeWeight,
    username,
  });

  await mkdir(dirname(output), { recursive: true });
  await mkdir(dirname(auditOutput), { recursive: true });
  await writeFile(output, svg, "utf8");
  await writeFile(auditOutput, `${JSON.stringify(audit, null, 2)}\n`, "utf8");
  console.log(`Wrote ${output}.`);
  console.log(`Wrote ${auditOutput}.`);
  console.log(
    `Displayed languages: ${displayedLanguages
      .map((language) => `${language.name} ${language.percent.toFixed(1)}%`)
      .join(", ")}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
