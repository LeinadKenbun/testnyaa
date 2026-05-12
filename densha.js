// TokyoTosho provider for Hayase
//
// Approach: parse TT's search page HTML (not RSS).
// The HTML search page at /search.php includes direct torrent links,
// seeders, leechers, size, and date — everything we need.
// The page responds with: Access-Control-Allow-Origin: *
// (Unlike the RSS endpoint which does not.)
//
// Search URL: https://www.tokyotosho.info/search.php?terms=<q>&type=<cat>
// type=0 = All, type=1 = Anime, type=7 = Raws, type=4 = Hentai

const TT = "https://www.tokyotosho.info";

export default new class {
  url = atob("aHR0cHM6Ly93d3cudG9reW90b3Noby5pbmZvLw==");

  _cat(media) {
    if (media.isAdult || media.genres?.includes("Hentai")) return 4;
    return 1; // Anime (TT also shows Raws under type=0 if needed)
  }

  async _fetch(query, type) {
    const url =
      `${TT}/search.php` +
      `?terms=${encodeURIComponent(query)}` +
      `&type=${type}` +
      `&searchName=true` +
      `&searchComment=false`;
    const res = await fetch(url);
    if (res.status === 429) throw new Error("Rate limited by TokyoTosho — try again shortly");
    if (!res.ok) throw new Error(`TokyoTosho error ${res.status}`);
    return parseHTML(await res.text());
  }

  async single(
    { media, episode, exclusions, episodeCount, absoluteEpisodeNumber },
    _,
    isBatch = false
  ) {
    if (!navigator.onLine) return [];

    const titles     = pickTitles(media);
    const type       = this._cat(media);
    const prequel    = findEdge(media, "PREQUEL")?.node;
    const sequel     = findEdge(media, "SEQUEL")?.node;
    const absoluteep = absoluteEpisodeNumber ?? episode;
    const episodes   = [episode];
    if (absoluteep !== episode && absoluteep > episodeCount) episodes.push(absoluteep);

    let epPart = "";
    if (episodeCount > 1) {
      if (isBatch) {
        const digits = Math.max(2, episodeCount.toString().length);
        epPart =
          `"${zeropad(1, digits)}-${zeropad(episodeCount, digits)}"` +
          `|"${zeropad(1, digits)}~${zeropad(episodeCount, digits)}"` +
          `|"1-${episodeCount}"|"1~${episodeCount}"` +
          `|"batch"|"complete"` +
          (prequel ? "" : '|"S01"');
      } else {
        epPart = episodes.map(epstring).join("|");
      }
    }

    const seen    = new Set();
    let   entries = [];

    for (let i = 0; i < titles.length; i++) {
      if (i > 0) await sleep(500);
      try {
        const q = buildQuery(titles[i], epPart);
        for (const entry of await this._fetch(q, type)) {
          if (!seen.has(entry.hash)) {
            seen.add(entry.hash);
            entries.push(entry);
          }
        }
        if (entries.length >= 50) break;
      } catch (e) {
        if (e.message.includes("Rate limited")) throw e;
      }
    }

    // Date-based prequel/sequel filtering
    const checkSequelDate =
      media.status === "FINISHED" &&
      (sequel?.status === "FINISHED" || sequel?.status === "RELEASING") &&
      sequel?.startDate;
    const sequelStartDate =
      checkSequelDate && new Date(Object.values(checkSequelDate).join(" "));

    const checkPrequelDate =
      (media.status === "FINISHED" || media.status === "RELEASING") &&
      prequel?.status === "FINISHED" && prequel?.endDate;
    const prequelEndDate =
      checkPrequelDate && new Date(Object.values(checkPrequelDate).join(" "));

    if (prequelEndDate)
      entries = entries.filter(e => e.date > new Date(+prequelEndDate + 10699393840));
    if (sequelStartDate && media.format === "TV")
      entries = entries.filter(e => e.date < new Date(+sequelStartDate - 10699393840));

    entries.sort((a, b) => b.seeders - a.seeders);
    return entries;
  }

  batch = (args, opts) => this.single(args, opts, true);
  movie = this.batch;

  async test() {
    try {
      const res = await fetch(`${TT}/search.php?terms=test&type=1`);
      if (!res.ok) throw new Error(res.statusText);
      const html = await res.text();
      if (!html.includes("tokyotosho")) throw new Error("Unexpected response");
      return true;
    } catch (e) {
      throw new Error(`Could not reach TokyoTosho!\n${e.message}`);
    }
  }
};

// ─── HTML parser ─────────────────────────────────────────────────────────────
//
// TT search result rows look like:
//
// <tr class="category_0">   (or category_1, category_7, etc.)
//   <td>...</td>            (category icon)
//   <td class="desc-top">
//     <a href="https://…torrent">TITLE</a>   ← torrent link + title
//     <a href="https://…">Website</a>
//     <a href="/details.php?id=NNN">Details</a>
//   </td>
//   <td class="desc-bot">
//     ... Size: X.XXmb ... S:NN L:NN C:NN ID:NNN
//     Date: YYYY-MM-DD HH:MM UTC
//   </td>
// </tr>

function parseHTML(html) {
  if (!html) return [];
  const entries = [];

  // Match each result row
  const rowRe = /<tr[^>]+class="category_\d+"[^>]*>([\s\S]*?)<\/tr>/gi;
  let row;

  while ((row = rowRe.exec(html)) !== null) {
    const cell = row[1];

    // Torrent link + title — first <a> in desc-top td
    const linkMatch = /href="(https?:\/\/[^"]+\.torrent[^"]*)"[^>]*>([^<]+)</i.exec(cell);
    if (!linkMatch) continue;

    const link  = linkMatch[1];
    const title = decodeEntities(linkMatch[2].trim());

    // Seeders / Leechers from "S:NN L:NN"
    const slMatch = /S:\s*(\d+)\s+L:\s*(\d+)/i.exec(cell);
    const seeders  = slMatch ? parseInt(slMatch[1], 10) : 0;
    const leechers = slMatch ? parseInt(slMatch[2], 10) : 0;

    // Size — "Size: X.XXmb" or "X.XX MB" etc.
    const sizeMatch = /Size:\s*([\d.]+)\s*(B|KB|MB|GB|TB|KiB|MiB|GiB|TiB)/i.exec(cell);
    const sizeInBytes = sizeMatch
      ? parseFloat(sizeMatch[1]) * (sizeMap[sizeMatch[2].toUpperCase()] || 1)
      : 0;

    // Date — "Date: YYYY-MM-DD HH:MM UTC"
    const dateMatch = /Date:\s*(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+UTC)/i.exec(cell);
    const date = dateMatch ? new Date(dateMatch[1]) : new Date(0);

    // Hash — extract 40-char hex from torrent URL if present
    const hashMatch = /([0-9a-fA-F]{40})/.exec(link);
    const idMatch   = /id=(\d+)/i.exec(cell);
    const hash      = hashMatch?.[1] || idMatch?.[1] || link;

    entries.push({ title, link, seeders, leechers, downloads: 0, size: sizeInBytes, hash, accuracy: "low", date });
  }

  return entries;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

const sizeMap = {
  B: 1, KB: 1000, MB: 1e6, GB: 1e9, TB: 1e12,
  KIB: 1024, MIB: 1024 ** 2, GIB: 1024 ** 3, TIB: 1024 ** 4
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

function zeropad(v = 1, l = 2) {
  return (typeof v === "string" ? v : v.toString()).padStart(l, "0");
}

const epstring = ep =>
  `"E${zeropad(ep)}+"|"E${zeropad(ep)}v"|"+${zeropad(ep)}+"|"+${zeropad(ep)}v"|"+${zeropad(ep)}-"`;

function buildQuery(title, epPart) {
  let q = title.replace(/[&?#]/g, " ").replace(/\s+/g, " ").trim();
  if (epPart) {
    const firstEp = epPart.match(/"([^"]+)"/)?.[1]?.replace(/[+v-]/g, "").trim();
    if (firstEp) q += ` ${firstEp}`;
  }
  return q;
}

function pickTitles(media) {
  const { romaji, english } = media.title;
  const candidates = [];
  const push = t => {
    if (!t || t.length <= 3) return;
    const norm = t.trim();
    if (!candidates.some(c => c.toLowerCase() === norm.toLowerCase()))
      candidates.push(norm);
  };
  push(romaji);
  if (english && english !== romaji) push(english);
  for (const t of [romaji, english]) {
    if (!t) continue;
    const m2 = t.match(/Season (\d)/i);
    const m1 = t.match(/(\d)(?:nd|rd|th) Season/i);
    if (m2) push(t.replace(/Season \d/i, `S${m2[1]}`));
    else if (m1) push(t.replace(/(\d)(?:nd|rd|th) Season/i, `S${m1[1]}`));
  }
  if (candidates.length === 0) {
    const syn = [...(media.synonyms || [])]
      .filter(s => s && s.length > 3)
      .sort((a, b) => a.length - b.length)[0];
    push(syn);
  }
  return candidates.slice(0, 3);
}

function findEdge(media, type, formats = ["TV", "TV_SHORT"], skip) {
  let res = media.relations.edges.find(
    e => e.relationType === type && formats.includes(e.node.format)
  );
  if (!res && !skip && type === "SEQUEL")
    res = findEdge(media, type, ["TV", "TV_SHORT", "OVA"], true);
  return res;
}

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#34;/g, '"').replace(/&#39;/g, "'");
}
