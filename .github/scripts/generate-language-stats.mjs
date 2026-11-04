import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const API_ROOT = "https://api.github.com";
const DEFAULT_OUTPUT = "assets/top-langs.svg";
const MAX_LANGUAGES = 8;

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
  const includedRepositories = repositories.filter((repository) => {
    return !repository.fork
      && !excludedRepos.has(repository.name.toLowerCase())
      && !excludedRepos.has(repository.full_name.toLowerCase());
  });

  for (let offset = 0; offset < includedRepositories.length; offset += 6) {
    const batch = includedRepositories.slice(offset, offset + 6);

    await Promise.all(batch.map(async (repository) => {
      const url = `${API_ROOT}/repos/${repository.full_name}/languages`;
      const languages = await requestJson(url, headers);

      for (const [language, bytes] of Object.entries(languages)) {
        const current = totals.get(language) ?? { bytes: 0, repositories: 0 };
        totals.set(language, {
          bytes: current.bytes + bytes,
          repositories: current.repositories + 1,
        });
      }
    }));
  }

  return totals;
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

function buildLanguageRows(
  languageTotals,
  limit,
  sizeWeight,
  countWeight,
) {
  const languages = [...languageTotals.entries()]
    .filter(([, stats]) => stats.bytes > 0);
  const totalBytes = languages.reduce((sum, [, stats]) => sum + stats.bytes, 0);
  const totalRepositoryUses = languages.reduce(
    (sum, [, stats]) => sum + stats.repositories,
    0,
  );

  if (totalBytes === 0) {
    return [];
  }

  const weights = normalizeWeights(sizeWeight, countWeight);
  const scoredLanguages = languages
    .map(([name, stats]) => ({
      name,
      score: weights.sizeWeight * (stats.bytes / totalBytes)
        + weights.countWeight * (stats.repositories / totalRepositoryUses),
    }))
    .sort((left, right) => right.score - left.score);
  const topLanguages = scoredLanguages.slice(0, limit);
  const otherScore = scoredLanguages
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
  sizeWeight = 0.5,
  countWeight = 0.5,
) {
  const rows = buildLanguageRows(
    languageTotals,
    limit,
    sizeWeight,
    countWeight,
  );
  const width = 495;
  const height = 180;
  const barX = 25;
  const barY = 24;
  const barWidth = width - barX * 2;
  const barHeight = 10;
  const columnWidth = 222;
  const legendStartY = 63;
  const rowHeight = 24;

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
    const column = Math.floor(index / 5);
    const rowIndex = index % 5;
    const x = barX + column * columnWidth;
    const y = legendStartY + rowIndex * rowHeight;
    const percent = row.percent >= 1
      ? row.percent.toFixed(1)
      : row.percent.toFixed(2);

    return `<g>
      <circle cx="${x + 4}" cy="${y - 4}" r="4" fill="${row.color}"/>
      <text x="${x + 14}" y="${y}" fill="#C9D1D9" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" font-size="12">${escapeXml(row.name)}</text>
      <text x="${x + columnWidth - 24}" y="${y}" fill="#8B949E" text-anchor="end" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" font-size="12">${percent}%</text>
    </g>`;
  }).join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Most used programming languages">
  <title>GitHub language statistics</title>
  <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="6" fill="#0D1117" stroke="#30363D"/>
  <clipPath id="language-bar"><rect x="${barX}" y="${barY}" width="${barWidth}" height="${barHeight}" rx="5"/></clipPath>
  <g clip-path="url(#language-bar)">${bars}</g>
  ${legend}
</svg>
`;
}

async function main() {
  const username = process.env.GH_USERNAME || "ZNNW";
  const token = process.env.GITHUB_TOKEN;
  const output = process.env.OUTPUT || DEFAULT_OUTPUT;
  const limit = Number(process.env.LANGS_COUNT || MAX_LANGUAGES);
  const sizeWeight = Number(process.env.SIZE_WEIGHT || 0.5);
  const countWeight = Number(process.env.COUNT_WEIGHT || 0.5);
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

  const languageTotals = await collectLanguageStats(
    repositories,
    headers,
    excludedRepos,
  );
  const svg = renderLanguageSvg(
    languageTotals,
    limit,
    sizeWeight,
    countWeight,
  );

  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, svg, "utf8");
  console.log(`Wrote ${output}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
