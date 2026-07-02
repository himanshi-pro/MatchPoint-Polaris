(function(){
  "use strict";

  /* ---------------- Live Google Sheets source (gviz JSONP — works even from file://) ---------------- */
  const SHEET_ID = "1gAIhAvT0c0oPIFrPKweJ6PkYFKa7kltg6P_pjd9_Igw";
  const STUDENTS_TAB = "Students";
  const COMPANIES_TAB = "Companies";
  const REFRESH_MS = 45000; // re-check the sheet for edits every 45s

  let jsonpCounter = 0;

  // Loads one tab via a <script> tag instead of fetch(). Script tags aren't subject
  // to CORS or to the file:// restrictions that block fetch()/XHR, which makes this
  // work whether the dashboard is opened locally by double-click or hosted online.
  function fetchTabViaJsonp(tabName){
    return new Promise((resolve, reject) => {
      jsonpCounter += 1;
      const cbName = `__gvizCb_${Date.now()}_${jsonpCounter}`;
      const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:json;responseHandler:${cbName}&headers=1&sheet=${encodeURIComponent(tabName)}&_ts=${Date.now()}`;

      let settled = false;
      const script = document.createElement("script");

      const cleanup = () => {
        delete window[cbName];
        if (script.parentNode) script.parentNode.removeChild(script);
        clearTimeout(timer);
      };

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(`Timed out loading the "${tabName}" tab.`));
      }, 15000);

      window[cbName] = (data) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (!data || !data.table) {
          reject(new Error(`Unexpected response for the "${tabName}" tab.`));
          return;
        }
        resolve(data.table);
      };

      script.onerror = () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(`Could not reach the "${tabName}" tab — check that the sheet is shared and the tab name is correct.`));
      };

      script.src = url;
      document.head.appendChild(script);
    });
  }

  // Convert a gviz `table` object into { fields, data } shaped like Papa.parse's output,
  // so the rest of the pipeline below doesn't need to change.
  function tableToRows(table){
    const fields = (table.cols || []).map((c, i) => (c.label && c.label.trim()) || c.id || `Column ${i + 1}`);
    const data = (table.rows || []).map(row => {
      const obj = {};
      fields.forEach((field, i) => {
        const cell = row.c && row.c[i];
        let value = "";
        if (cell) {
          value = (cell.f !== undefined && cell.f !== null) ? cell.f : cell.v;
        }
        obj[field] = value === null || value === undefined ? "" : String(value);
      });
      return obj;
    });
    return { fields, data };
  }

  function titleCase(str){
    return str.replace(/\w\S*/g, w => w[0].toUpperCase() + w.slice(1).toLowerCase())
              .replace(/\bAi\b/g, "AI");
  }

  function slug(str){
    return String(str || "").toLowerCase().trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "");
  }

  /* ---------------- Field classification helpers ---------------- */
  let RAW_HEADERS = [];
  let COMPANIES = [];
  let NAME_KEY = null, UNIVERSITY_KEY = null, EMAIL_KEY = null, PHONE_KEY = null;
  let CONTACT_KEYS = [];
  // Semantic roles used by the analysis engine below — found by pattern, not hardcoded,
  // so this still degrades gracefully if the sheet's questions are reworded.
  let PROGRAM_KEY = null, GRADYEAR_KEY = null, CITY_KEY = null, TECHSTACK_KEY = null;
  let WHY_KEY = null, PROUD_KEY = null, BESTPROJECT_KEY = null, SELFTAUGHT_KEY = null;
  let REPOEXPLAIN_KEY = null, DEBUG_KEY = null, VALIDATION_KEY = null, AI_PERSONA_KEY = null;
  let STUDENTS = [];

  function findHeader(regex){
    return RAW_HEADERS.find(h => regex.test(h));
  }

  function isUrl(value){
    return typeof value === "string" && /^https?:\/\/\S+$/i.test(value.trim());
  }

  function shortLinkLabel(header){
    const h = header.toLowerCase();
    if (h.includes("linkedin")) return "LinkedIn";
    if (h.includes("github")) return "GitHub";
    if (h.includes("resume") || h.includes("cv")) return "Resume";
    if (h.includes("portfolio")) return "Portfolio";
    if (h.includes("video")) return "Intro Video";
    if (h.includes("repo") || h.includes("demo") || h.includes("artifact") || h.includes("project")) return "Project Link";
    if (h.includes("certificat")) return "Certificate";
    if (h.includes("drive")) return "Drive Link";
    // fallback: trim header to a short label
    const words = header.split(/\s+/).slice(0, 3).join(" ");
    return words.length > 28 ? words.slice(0, 28) + "…" : words;
  }

  function cleanLongLabel(header){
    // Use header as-is for long-text section titles, trimmed of trailing punctuation.
    return header.replace(/\s+/g, " ").trim();
  }

  function initials(name){
    if (!name) return "?";
    const parts = name.trim().split(/\s+/);
    return ((parts[0]?.[0] || "") + (parts[1]?.[0] || "")).toUpperCase();
  }

  function escapeHtml(str){
    return String(str)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /* ---------------- Build normalized student objects ---------------- */
  /* =====================================================================
     STUDENT ANALYSIS ENGINE
     Adapted from student-analysis-logic.js. The original module's
     getAiAnalysis()/buildPrompt()/parseAiJson() called api.anthropic.com
     directly from the browser — that call has no way to succeed here
     (no key, no server to hold one), so it was silently failing on every
     student and always falling through to the heuristic fallback, which
     only produced generic canned category labels ("Internship experience",
     "Strong portfolio"...) with nothing specific to the actual person.
     That live-API path is removed entirely below. In its place, the
     heuristic layer itself now pulls the actual sentence that triggered
     each match out of the student's own free-text answers, so what's
     shown is that person's specific words, not a canned label.
     Renamed getAiAnalysis -> computeStudentAnalysis to reflect that it's
     a plain synchronous function now, not an async AI call.
     ===================================================================== */

  var SKILL_DICT = {
    "Programming Languages": ["java","python","javascript","typescript","c++","c#","c","golang","go","rust","kotlin","swift","php","ruby","r","sql","html","css","dart","scala","bash","shell","matlab"],
    "Frameworks": ["react","reactjs","angular","angularjs","vue","vuejs","node.js","nodejs","express","django","flask","spring","fastapi","next.js","nextjs",".net","streamlit","mern","bootstrap","tailwind","jquery","laravel","nestjs","redux","react native","flutter","electron","hibernate","jpa"],
    "Databases": ["mongodb","mongo","mysql","postgresql","postgres","postgress","sqlite","redis","firebase","dynamodb","cassandra","oracle db","mariadb","supabase","neo4j","elasticsearch","nosql"],
    "Cloud": ["aws","azure","gcp","google cloud","vercel","netlify","heroku","cloudflare","digitalocean","s3","ec2","lambda"],
    "DevOps": ["docker","kubernetes","ci/cd","jenkins","github actions","terraform","ansible","nginx","linux","git","github","gitlab","k8s","eks","helm","maven"],
    "AI / ML": ["nlp","llm","llms","generative ai","tensorflow","pytorch","scikit-learn","sklearn","opencv","machine learning","deep learning","face api","rag","prompt engineering","computer vision","keras","langchain","hugging face","huggingface","transformers","genai","ai/ml","artificial intelligence","openai","claude","gemini","bert","gpt","nemo","asr","conformer","cuda","vector database"],
    "Tools": ["postman","figma","jira","vs code","notion","slack","excel","power bi","tableau","canva","adobe","webpack","vite"]
  };

  function isWordChar(ch){ return ch !== undefined && /[a-z0-9]/i.test(ch); }

  function keywordMatches(haystackLower, keyword){
    var idx = haystackLower.indexOf(keyword);
    if (idx === -1) return false;
    var before = idx === 0 ? undefined : haystackLower[idx - 1];
    var after = (idx + keyword.length >= haystackLower.length) ? undefined : haystackLower[idx + keyword.length];
    return !isWordChar(before) && !isWordChar(after);
  }

  var SKIP_SEGMENT_LABELS = /^(coursework|soft skills?|academics?)$/i;

  function categorizeStack(stackStr){
    var out = {"Programming Languages":[], "Frameworks":[], "Databases":[], "Cloud":[], "DevOps":[], "AI / ML":[], "Tools":[], "Other Technologies":[]};
    if (!stackStr) return out;

    var segments = stackStr.split("//").map(function(s){ return s.trim(); }).filter(Boolean);
    var rawTokens = [];
    segments.forEach(function(seg){
      var labelMatch = seg.match(/^([A-Za-z &/]{2,30}):\s*(.*)$/);
      var label = labelMatch ? labelMatch[1].trim() : null;
      var content = labelMatch ? labelMatch[2] : seg;
      if (label && SKIP_SEGMENT_LABELS.test(label)) return;
      content = content.replace(/[()]/g, ",");
      var tokens = content.split(/[,/]|(?:\s+and\s+)/i).map(function(t){ return t.trim().replace(/\.$/, ""); }).filter(Boolean);
      rawTokens = rawTokens.concat(tokens);
    });

    rawTokens = Array.from(new Set(rawTokens.filter(function(t){ return t.length > 0 && t.length < 45; })));

    rawTokens.forEach(function(tok){
      var low = tok.toLowerCase();
      var placed = false;
      var catOrder = ["Programming Languages","Databases","Cloud","DevOps","Frameworks","AI / ML","Tools"];
      for (var c = 0; c < catOrder.length; c++){
        var cat = catOrder[c];
        var kws = SKILL_DICT[cat];
        for (var i = 0; i < kws.length; i++){
          if (keywordMatches(low, kws[i].trim())){
            out[cat].push(tok);
            placed = true;
            break;
          }
        }
        if (placed) break;
      }
      if (!placed) out["Other Technologies"].push(tok);
    });

    return out;
  }

  var HIGHLIGHT_RULES = [
    { key: "hackathon", label: "Hackathon experience", icon: "🏆", patterns: [/hackathon/i] },
    { key: "opensource", label: "Open source contributor", icon: "🌐", patterns: [/open[\s-]?source/i] },
    { key: "internship", label: "Internship experience", icon: "💼", patterns: [/intern(ship)?s?\b/i] },
    { key: "github", label: "Active GitHub presence", icon: "💻", patterns: [/github/i] },
    { key: "competitive", label: "Competitive programming", icon: "⚡", patterns: [/competitive programming/i, /leetcode/i, /codeforces/i, /codechef/i, /\bcp\b/] },
    { key: "research", label: "Research work", icon: "🔬", patterns: [/\bresearch\b/i] },
    { key: "publication", label: "Published work", icon: "📄", patterns: [/publicat(ion|ed)/i, /\bpaper\b/i, /journal/i] },
    { key: "certification", label: "Certifications", icon: "📜", patterns: [/certif(ied|ication)/i] },
    { key: "cloud_infra", label: "Cloud / infra work", icon: "☁️", patterns: [/deployed?/i, /\baws\b/i, /\bazure\b/i, /\bcloud\b/i] },
    { key: "startup", label: "Startup experience", icon: "🚀", patterns: [/startup/i, /\bfounder\b/i, /co-founder/i] },
    { key: "award", label: "Award / recognition", icon: "🏅", patterns: [/\baward\b/i, /\bwinner\b/i, /\bwon\b/i, /\brank(ed)?\b/i, /top \d/i] },
    { key: "leadership", label: "Leadership role", icon: "🧭", patterns: [/lead(er|ership)?\b/i, /\bpresident\b/i, /\bhead\b/i, /founder/i, /captain/i] },
    { key: "freelance", label: "Freelance work", icon: "🧾", patterns: [/freelanc/i] },
    { key: "mentor", label: "Teaching / mentoring", icon: "🎓", patterns: [/mentor/i, /\bteach(ing)?\b/i, /\btutor/i] },
    { key: "community", label: "Community contribution", icon: "🤝", patterns: [/community/i, /volunteer/i, /\bclub\b/i] }
  ];

  // Fields scanned for narrative highlight extraction, richest/most-personal first.
  function narrativeFields(student){
    return [student.proudAchievement, student.bestProject, student.whyFellowship,
      student.selfTaught, student.repoExplain, student.debugStory];
  }

  function detectHighlights(student){
    var text = narrativeFields(student).concat([student.validationReason, student.techStack]).join(" \n ");
    var found = [];
    HIGHLIGHT_RULES.forEach(function(rule){
      var hit = rule.patterns.some(function(p){ return p.test(text); });
      if (hit) found.push({ key: rule.key, label: rule.label, icon: rule.icon });
    });
    return found;
  }

  var DANGLING_TAIL = /\s+(and|or|but|with|that|which|of|to|for|in|on|at|by|the|a|an)$/i;
  function stripDanglingTail(s){
    var prev;
    do { prev = s; s = s.replace(DANGLING_TAIL, ""); } while (s !== prev);
    return s.trim();
  }

  /** Extracts a complete clause/sentence, cutting only at a natural boundary
   *  (sentence end, comma, "and") — never mid-word with a dangling "…", so the
   *  result always reads as a finished thought. */
  function cleanSentence(text, maxLen){
    if (!text) return "";
    var firstSentence = text.trim().split(/[.!?\n]/)[0].trim();
    if (!firstSentence) return "";
    if (firstSentence.length <= maxLen) return firstSentence;
    var slice = firstSentence.slice(0, maxLen);
    var lastBreak = Math.max(slice.lastIndexOf(","), slice.lastIndexOf(";"), slice.lastIndexOf(" and "), slice.lastIndexOf(" — "));
    if (lastBreak > maxLen * 0.35){
      return stripDanglingTail(slice.slice(0, lastBreak));
    }
    return stripDanglingTail(slice.replace(/\s+\S*$/, ""));
  }

  /** Converts first-person free text to third person (singular "they"), so nothing
   *  quoted from a student's own answers reads as "I built X" in their dossier. */
  function toThirdPerson(text){
    if (!text) return text;
    return text
      .replace(/\bI'm\b/g, "They're")
      .replace(/\bI've\b/g, "They've")
      .replace(/\bI'll\b/g, "They'll")
      .replace(/\bI'd\b/g, "They'd")
      .replace(/\bI am\b/g, "they are")
      .replace(/\bI have\b/g, "they have")
      .replace(/\bI had\b/g, "they had")
      .replace(/\bI was\b/g, "they were")
      .replace(/\bI will\b/g, "they will")
      .replace(/\bI would\b/g, "they would")
      .replace(/\bmyself\b/gi, "themselves")
      .replace(/\bmy\b/g, "their")
      .replace(/\bMy\b/g, "Their")
      .replace(/\bme\b/g, "them")
      .replace(/\bI\b/g, "they")
      .replace(/^./, function(c){ return c.toUpperCase(); });
  }

  /** Strips a generic first-person lead-in ("The best project I have built is...")
   *  so a bullet starts directly on the substance instead of restating the question. */
  var LEAD_INS = [
    /^the best project i(?:'ve| have) built is\s*/i,
    /^a recent achievement i(?:'m| am) (?:most )?proud of (?:is|was)\s*/i,
    /^the achievement i(?:'m| am) most proud of is\s*/i,
    /^during my\s+/i,
    /^i believe\s+/i,
    /^i(?:'m| am)\s+/i
  ];
  function stripLeadIn(t){
    var out = t;
    for (var i = 0; i < LEAD_INS.length; i++){
      if (LEAD_INS[i].test(out)){ out = out.replace(LEAD_INS[i], ""); break; }
    }
    return out.charAt(0).toUpperCase() + out.slice(1);
  }

  function joinNatural(arr){
    if (arr.length === 0) return "";
    if (arr.length === 1) return arr[0];
    if (arr.length === 2) return arr[0] + " and " + arr[1];
    return arr.slice(0, -1).join(", ") + ", and " + arr[arr.length - 1];
  }

  /* ---------------------------------------------------------------------
     FACT EXTRACTION: pulls specific counts, program names, and org names
     out of a student's own text per achievement category, instead of
     quoting a sentence or falling back to a generic category label.
     e.g. "3 internships completed", "Selected for GSoC (2025)",
          "Solved 1600+ DSA problems (Knight-rated on LeetCode)"
     --------------------------------------------------------------------- */

  function looksLikeYear(n){
    return n >= 1900 && n <= 2099 && String(n).length === 4;
  }

  function numNear(text, nounSrc){
    var re = new RegExp("(\\d[\\d,]*)\\+?\\s*(?:x\\s*)?(?:times?\\s*)?(?:" + nounSrc + ")", "i");
    var m = text.match(re);
    if (m){
      var n1 = parseInt(m[1].replace(/,/g, ""), 10);
      if (!looksLikeYear(n1)) return n1;
    }
    var re2 = new RegExp("(?:" + nounSrc + ")[^\\d]{0,18}(\\d[\\d,]*)\\+?", "i");
    var m2 = text.match(re2);
    if (m2){
      var n2 = parseInt(m2[1].replace(/,/g, ""), 10);
      if (!looksLikeYear(n2)) return n2;
    }
    return null;
  }

  var FACT_EXTRACTORS = {
    internship: function(text){
      var n = numNear(text, "intern(?:ship)?s?");
      var company = text.match(/[Ii]ntern(?:ed|ship)?\s+at\s+([A-Z][A-Za-z0-9&.\- ]{2,30})/);
      if (n) return n + " internship" + (n > 1 ? "s" : "") + " completed" + (company ? " (incl. " + company[1].trim() + ")" : "");
      if (company) return "Interned at " + company[1].trim();
      return "Internship experience";
    },
    opensource: function(text){
      var progs = [];
      [[/g(?:oogle)? ?soc\b|google summer of code/i, "GSoC"],
       [/outreachy/i, "Outreachy"],
       [/summer of bitcoin/i, "Summer of Bitcoin"],
       [/girlscript summer of code|gssoc/i, "GirlScript Summer of Code"],
       [/\blfx\b/i, "LFX Mentorship"],
       [/\bc4gt\b/i, "Code for GovTech"],
       [/hacktoberfest/i, "Hacktoberfest"]
      ].forEach(function(pair){ if (pair[0].test(text) && progs.indexOf(pair[1]) === -1) progs.push(pair[1]); });
      var year = text.match(/\b(20\d{2})\b/);
      if (progs.length) return "Selected for " + joinNatural(progs) + (year ? " (" + year[1] + ")" : "");
      return "Open source contributor";
    },
    github: function(text){
      var stars = text.match(/(\d[\d,]*)\+?\s*(?:github\s*)?stars?/i);
      if (stars) return stars[1] + "+ GitHub stars earned on personal projects";
      return "Active GitHub contributor";
    },
    hackathon: function(text){
      var count = numNear(text, "(?:global\\s+)?hackathons?");
      var isWinner = /\bwon\b|\bwinner\b|\bwins\b|\bfirst place\b/i.test(text);
      var named = text.match(/([A-Z][A-Za-z0-9&' ]{2,40}\bHackathon\b)/);
      if (count) return count + "× hackathon " + (isWinner ? "winner" : "participant") + (named ? " (" + named[1].trim() + ")" : "");
      if (named) return (isWinner ? "Won " : "Competed in ") + named[1].trim();
      return isWinner ? "Hackathon winner" : "Hackathon experience";
    },
    research: function(text){
      if (/\bieee\b/i.test(text)) return "Co-authored an IEEE conference paper";
      var venue = text.match(/([A-Z][A-Za-z0-9 ]{4,40}(?:Journal|Conference|Symposium))/);
      if (venue) return "Published research at " + venue[1].trim();
      if (/publicat(ion|ed)|\bpaper\b|journal/i.test(text)) return "Published research work";
      return "Research experience";
    },
    publication: function(text){
      if (/\bieee\b/i.test(text)) return "Co-authored an IEEE conference paper";
      return "Published work";
    },
    leadership: function(text){
      var team = text.match(/(\d+)[- ]?\+?\s*(?:member|people|students?)\s*(?:team|group)?/i);
      if (team) return "Leads a " + team[1] + "-member team";
      var role = text.match(/\b(president|co-founder|founder|captain|head)\b/i);
      if (role) return role[1].charAt(0).toUpperCase() + role[1].slice(1).toLowerCase() + " / leadership role";
      return "Leadership role";
    },
    award: function(text){
      var named = text.match(/(?:[Ww]on|[Ww]inner of|[Ss]ecured|[Aa]warded|[Rr]unner[- ]?up (?:at|in))\s+([A-Z][A-Za-z0-9&']{2,}(?:\s[A-Z][A-Za-z0-9&']{2,}){0,6})/);
      if (named) return "Recognized: " + named[1].trim();
      var rank = text.match(/top\s+(\d+)(?:\s+out of\s+(?:more than\s+)?(\d[\d,]*))?/i);
      if (rank) return "Ranked top " + rank[1] + (rank[2] ? (" of " + rank[2]) : "");
      return "Award / recognition";
    },
    certification: function(text){
      var n = numNear(text, "certificat\\w*");
      if (n) return n + " professional certification" + (n > 1 ? "s" : "");
      return "Certified in relevant technologies";
    },
    competitive: function(text){
      var solved = text.match(/(\d[\d,]*)\+?\s*(?:dsa\s*)?problems/i);
      var knight = /knight/i.test(text);
      if (solved) return "Solved " + solved[1] + "+ DSA problems" + (knight ? " (Knight-rated on LeetCode)" : "");
      if (knight) return "Knight-rated competitive programmer";
      return "Competitive programming background";
    },
    freelance: function(){ return "Freelance project experience"; },
    mentor: function(text){
      var n = numNear(text, "(?:students?|mentees?|people)");
      if (n) return "Mentored " + n + "+ students";
      return "Teaching / mentoring experience";
    },
    startup: function(text){
      var named = text.match(/(?:[Ff]ounded|[Cc]o-founded|[Ff]ounder of)\s+([A-Z][A-Za-z0-9&']{1,}(?:\s[A-Z][A-Za-z0-9&'.\-]{1,}){0,4})/);
      if (named) return "Founded " + named[1].trim();
      return "Startup / founder experience";
    },
    community: function(){ return "Active community contributor"; },
    cloud_infra: function(text){
      var pct = text.match(/(?:reduced?|cut|improved?).{0,25}(?:by\s+)?(\d{1,3})%/i) || text.match(/(\d{1,3})%\s*(?:reduction|faster|improvement)/i);
      if (pct) return "Improved system performance by " + pct[1] + "%";
      return "Cloud / infrastructure deployment experience";
    }
  };

  /**
   * For each matched achievement category, computes a specific, factual
   * phrase (a count, a named program, an org) from the student's own text —
   * not a quoted sentence and not a generic label.
   */
  function computeFactHighlights(student){
    var text = narrativeFields(student).concat([student.validationReason, student.techStack]).filter(Boolean).join(" \n ");
    var out = [];
    HIGHLIGHT_RULES.forEach(function(rule){
      var hit = rule.patterns.some(function(p){ return p.test(text); });
      if (!hit) return;
      var extractor = FACT_EXTRACTORS[rule.key];
      var phrase = extractor ? extractor(text) : rule.label;
      out.push({ key: rule.key, icon: rule.icon, text: phrase });
    });
    return out.slice(0, 6);
  }

  function fieldFilled(v){ return v && String(v).trim().length > 0; }

  var COMPLETENESS_FIELDS = ["linkedin","github","portfolio","resume","techStack","whyFellowship",
    "introVideo","proudAchievement","bestProject","selfTaught","repoLink","repoExplain","debugStory","validationReason"];

  function completeness(student){
    var filled = COMPLETENESS_FIELDS.filter(function(f){ return fieldFilled(student[f]); }).length;
    return Math.round((filled / COMPLETENESS_FIELDS.length) * 100);
  }

  function textRichness(student){
    var t = [student.proudAchievement, student.bestProject, student.selfTaught, student.repoExplain, student.debugStory].join(" ");
    return t.split(/\s+/).filter(Boolean).length;
  }

  function signalScore(student){
    var hl = detectHighlights(student).length;
    var comp = completeness(student);
    var rich = textRichness(student);
    var linkBonus = ["linkedin","github","portfolio","resume"].filter(function(f){ return fieldFilled(student[f]); }).length;

    var score = 0;
    score += Math.min(hl, 8) * 6.5;
    score += (comp / 100) * 22;
    score += Math.min(rich / 400, 1) * 16;
    score += linkBonus * 2.5;
    return Math.max(5, Math.min(100, Math.round(score)));
  }

  function signalStars(score){
    return Math.max(1, Math.min(5, Math.round(score / 20)));
  }

  /** Builds a natural, third-person summary from computed facts — never quotes raw first-person text. */
  var TECH_HIGHLIGHT_KEYS = ["hackathon", "opensource", "internship", "github", "competitive",
    "research", "publication", "certification", "cloud_infra", "startup"];

  function buildSummary(student, factHighlights){
    var name = student.name || "This candidate";
    var cats = categorizeStack(student.techStack);
    var topSkills = []
      .concat(cats["Programming Languages"].slice(0, 4))
      .concat(cats["Frameworks"].slice(0, 3))
      .concat(cats["AI / ML"].slice(0, 2))
      .concat(cats["Databases"].slice(0, 2))
      .concat(cats["Cloud"].slice(0, 2));
    topSkills = topSkills.slice(0, 8);

    var bullets = [];
    
    // 1. Background & Foundation
    var programName = student.program || "engineering";
    var article = /^[aeiou]/i.test(programName) ? "an" : "a";
    var backgroundBullet = name + " is " + article + " " + programName + " student at " + (student.university || "their university");
    if (student.gradYear){
      backgroundBullet += ", graduating in " + student.gradYear;
    }
    backgroundBullet += ". This foundation has allowed them to develop expertise across multiple technical domains and demonstrate consistent growth.";
    bullets.push("• " + backgroundBullet);

    // 2. Technical Skills & Expertise
    if (topSkills.length){
      var skillsBullet = "They possess hands-on expertise in " + joinNatural(topSkills.slice(0, 4)) + ", which forms the core of their technical toolkit.";
      if (topSkills.length > 4){
        skillsBullet += " Beyond these primary skills, they have also explored and worked with " + joinNatural(topSkills.slice(4)) + ", demonstrating breadth and adaptability.";
      }
      skillsBullet += " This diverse skill set enables them to tackle projects that require multiple technologies and approaches.";
      bullets.push("• " + skillsBullet);
    }

    // 3. Domain Focus & Academic Interests
    if (student.categories && student.categories.length){
      var focusBullet = "Their focused interest in " + joinNatural(student.categories) + " shapes their project selection and career aspirations.";
      focusBullet += " This specialization indicates they're not just learning technologies, but developing expertise in meaningful problem spaces.";
      bullets.push("• " + focusBullet);
    }

    // 4-5. Technical Achievements & Highlights
    var techFacts = factHighlights.filter(function(h){ return TECH_HIGHLIGHT_KEYS.indexOf(h.key) !== -1; });
    var chosen = (techFacts.length ? techFacts : factHighlights).slice(0, 8).map(function(h){ return h.text; });
    
    if (chosen.length >= 3){
      var achieveBullet1 = "They have demonstrated significant achievements including " + joinNatural(chosen.slice(0, 3)) + ".";
      achieveBullet1 += " These accomplishments showcase their ability to deliver results and engage with real-world technical challenges.";
      bullets.push("• " + achieveBullet1);
      
      if (chosen.length > 3){
        var achieveBullet2 = "Additionally, their experience extends to " + joinNatural(chosen.slice(3, Math.min(6, chosen.length))) + ".";
        achieveBullet2 += " This breadth of experience indicates they can quickly adapt to new domains and apply their learning effectively.";
        bullets.push("• " + achieveBullet2);
      }
    } else if (chosen.length > 0){
      var achieveBullet = "They stand out for " + joinNatural(chosen) + ", demonstrating their ability to excel in diverse technical areas.";
      bullets.push("• " + achieveBullet);
    }

    // 6. Proud Achievement / Most Significant Work
    var proudAchievementClause = student.proudAchievement ? cleanSentence(toThirdPerson(stripLeadIn(student.proudAchievement)), 280) : "";
    if (proudAchievementClause){
      var loweredProud = proudAchievementClause.charAt(0).toLowerCase() + proudAchievementClause.slice(1);
      var proudBullet = "They take particular pride in the achievement where " + loweredProud + ".";
      proudBullet += " This work demonstrates their ability to identify important problems and execute solutions that create real value.";
      bullets.push("• " + proudBullet);
    }

    // 7. Best Project & Project Design Thinking
    var bestProjectClause = student.bestProject ? cleanSentence(toThirdPerson(stripLeadIn(student.bestProject)), 280) : "";
    if (bestProjectClause){
      var loweredBest = bestProjectClause.charAt(0).toLowerCase() + bestProjectClause.slice(1);
      var projectBullet = "Their best project work involved building something where " + loweredBest + ".";
      projectBullet += " This demonstrates not just technical execution, but thoughtful project design and understanding of user needs.";
      bullets.push("• " + projectBullet);
    }

    // 8. Repository & Code Understanding
    var repoExplainClause = student.repoExplain ? cleanSentence(toThirdPerson(stripLeadIn(student.repoExplain)), 280) : "";
    if (repoExplainClause){
      var loweredRepo = repoExplainClause.charAt(0).toLowerCase() + repoExplainClause.slice(1);
      var repoBullet = "Looking at their code and repositories reveals that " + loweredRepo + ".";
      repoBullet += " This indicates they think deeply about code organization, maintainability, and best practices.";
      bullets.push("• " + repoBullet);
    }

    // 9. Problem-Solving & Debugging Approach
    var debugStoryClause = student.debugStory ? cleanSentence(toThirdPerson(stripLeadIn(student.debugStory)), 280) : "";
    if (debugStoryClause){
      var loweredDebug = debugStoryClause.charAt(0).toLowerCase() + debugStoryClause.slice(1);
      var debugBullet = "When faced with difficult technical problems, their approach is that " + loweredDebug + ".";
      debugBullet += " This demonstrates systematic thinking, persistence, and the ability to learn from failures—critical traits for any engineer.";
      bullets.push("• " + debugBullet);
    }

    // 10. Self-Teaching & Learning Ability
    var selfTaughtClause = student.selfTaught ? cleanSentence(toThirdPerson(stripLeadIn(student.selfTaught)), 280) : "";
    if (selfTaughtClause){
      var loweredSelf = selfTaughtClause.charAt(0).toLowerCase() + selfTaughtClause.slice(1);
      var selfBullet = "They demonstrate strong self-learning capabilities, as evidenced by the fact that " + loweredSelf + ".";
      selfBullet += " This ability to independently acquire new skills is invaluable in a rapidly evolving tech landscape.";
      bullets.push("• " + selfBullet);
    }

    // 11. Fellowship Motivation & Career Direction
    var whyFellowshipClause = student.whyFellowship ? cleanSentence(toThirdPerson(stripLeadIn(student.whyFellowship)), 280) : "";
    if (whyFellowshipClause){
      var loweredWhy = whyFellowshipClause.charAt(0).toLowerCase() + whyFellowshipClause.slice(1);
      var motBullet = "They joined this fellowship because " + loweredWhy + ".";
      motBullet += " This motivation suggests they're intentional about their career growth and seek opportunities that align with their values and goals.";
      bullets.push("• " + motBullet);
    }

    // 12. Fallback: Technical Complementarity
    if (topSkills.length >= 2 && bullets.length < 8){
      var techFitBullet = "They have built a solid technical foundation in " + topSkills.slice(0, 2).join(" and ") + ".";
      techFitBullet += " This combination of skills positions them well for roles that require a blend of backend and frontend development, or systems work.";
      bullets.push("• " + techFitBullet);
    }

    // 13. Links & Online Presence
    var links = [];
    if (student.linkedin) links.push("LinkedIn");
    if (student.github) links.push("GitHub");
    if (student.portfolio) links.push("Portfolio");
    if (links.length > 0){
      var linkBullet = "They maintain an active online presence with " + joinNatural(links) + ", where you can see more of their work and professional background.";
      bullets.push("• " + linkBullet);
    }

    return bullets.join("\n").trim();
  }

  /** Third-person, lead-stripped experience bullets — not verbatim first-person quotes. */
  var EXPERIENCE_SOURCES = [
    { field: "proudAchievement", prefix: "" },
    { field: "bestProject", prefix: "" },
    { field: "repoExplain", prefix: "" },
    { field: "selfTaught", prefix: "" },
    { field: "debugStory", prefix: "" }
  ];

  function experienceBullets(student){
    var out = [];
    EXPERIENCE_SOURCES.forEach(function(src){
      var raw = student[src.field];
      if (!raw) return;
      var clause = cleanSentence(toThirdPerson(stripLeadIn(raw)), 150);
      if (clause) out.push(clause + ".");
    });
    return out;
  }

  /**
   * Splits the reviewer's validation reason into its own clean, specific
   * clauses (that person's actual words) instead of remapping it to a
   * small fixed dictionary of generic strength labels.
   */
  function validationInsights(student){
    var reason = (student.validationReason || "").trim();
    if (!reason) return [];
    var clauses = reason.split(/[,;]|(?:\s+and\s+)/i)
      .map(function(c){ return toThirdPerson(c.trim().replace(/^[-•]\s*/, "")); })
      .filter(function(c){ return c.length > 2; })
      .map(function(c){ return c.charAt(0).toUpperCase() + c.slice(1); });
    return clauses.length ? clauses : [toThirdPerson(reason)];
  }

  /**
   * Synchronous, fully local analysis for one student — no network call,
   * so nothing here can "silently fail" back to generic filler.
   */
  function computeStudentAnalysis(student){
    var facts = computeFactHighlights(student);
    return {
      summary: buildSummary(student, facts),
      highlights: facts,
      experienceBullets: experienceBullets(student),
      validationInsights: validationInsights(student),
      techCategories: categorizeStack(student.techStack),
      completenessPct: completeness(student),
      signalScore: signalScore(student),
      signalStars: signalStars(signalScore(student))
    };
  }


  function buildStudents(rawRows){
    const seenIds = {};
    return rawRows
      .filter(row => (row[NAME_KEY] || "").trim())
      .map(row => {
        const name = (row[NAME_KEY] || "").trim();
        const university = UNIVERSITY_KEY ? (row[UNIVERSITY_KEY] || "").trim() : "";

        // Stable id derived from name+university (not row index), so edits/reorders
        // in the sheet don't orphan existing shortlist data on refresh.
        let baseId = slug(name) + (university ? "-" + slug(university) : "");
        if (!baseId) baseId = "student";
        seenIds[baseId] = (seenIds[baseId] || 0) + 1;
        const id = seenIds[baseId] > 1 ? `${baseId}-${seenIds[baseId]}` : baseId;

        const links = [];      // { label, url, header }
        const contacts = [];   // { label, value }
        const longTexts = [];  // { label, value }
        const shortFields = []; // any other short non-empty fields
        const categories = []; // checkbox-style fields where the value just repeats the header

        RAW_HEADERS.forEach(header => {
          const raw = row[header];
          if (raw === undefined || raw === null) return;
          const value = String(raw).trim();
          if (!value) return;
          if (header === NAME_KEY) return;

          if (isUrl(value)) {
            links.push({ label: shortLinkLabel(header), url: value, header });
            return;
          }
          if (CONTACT_KEYS.includes(header)) {
            contacts.push({ label: header, value });
            return;
          }
          if (header === UNIVERSITY_KEY) return; // shown in header area already
          if (header === VALIDATION_KEY || header === AI_PERSONA_KEY) return; // not shown as a raw field
          // Google Forms checkbox columns export the option text as both the header
          // and the cell value when ticked — surface those as tags, not "X: X" rows.
          if (value.toLowerCase() === header.trim().toLowerCase()) {
            categories.push(value);
            return;
          }
          if (value.length > 140) {
            longTexts.push({ label: cleanLongLabel(header), value });
            return;
          }
          shortFields.push({ label: header, value });
        });

        // Build a lookup so the analysis engine can find links by role regardless
        // of the exact header wording used for them.
        const linkByLabel = {};
        links.forEach(l => { if (!linkByLabel[l.label]) linkByLabel[l.label] = l.url; });

        const analysisInput = {
          name, university,
          program: PROGRAM_KEY ? (row[PROGRAM_KEY] || "").trim() : "",
          gradYear: GRADYEAR_KEY ? (row[GRADYEAR_KEY] || "").trim() : "",
          city: CITY_KEY ? (row[CITY_KEY] || "").trim() : "",
          categories,
          linkedin: linkByLabel["LinkedIn"] || "",
          github: linkByLabel["GitHub"] || "",
          portfolio: linkByLabel["Portfolio"] || "",
          resume: linkByLabel["Resume"] || "",
          introVideo: linkByLabel["Intro Video"] || "",
          repoLink: linkByLabel["Project Link"] || linkByLabel["Drive Link"] || "",
          techStack: TECHSTACK_KEY ? (row[TECHSTACK_KEY] || "").trim() : "",
          whyFellowship: WHY_KEY ? (row[WHY_KEY] || "").trim() : "",
          proudAchievement: PROUD_KEY ? (row[PROUD_KEY] || "").trim() : "",
          bestProject: BESTPROJECT_KEY ? (row[BESTPROJECT_KEY] || "").trim() : "",
          selfTaught: SELFTAUGHT_KEY ? (row[SELFTAUGHT_KEY] || "").trim() : "",
          repoExplain: REPOEXPLAIN_KEY ? (row[REPOEXPLAIN_KEY] || "").trim() : "",
          debugStory: DEBUG_KEY ? (row[DEBUG_KEY] || "").trim() : "",
          validationReason: VALIDATION_KEY ? (row[VALIDATION_KEY] || "").trim() : ""
        };

        const analysis = computeStudentAnalysis(analysisInput);

        return { id, name, university, links, contacts, longTexts, shortFields, categories, analysis };
      });
  }

  async function loadSheetData(){
    const [studentsTable, companiesTable] = await Promise.all([
      fetchTabViaJsonp(STUDENTS_TAB),
      fetchTabViaJsonp(COMPANIES_TAB)
    ]);

    const studentsParsed = tableToRows(studentsTable);
    const companiesParsed = tableToRows(companiesTable);

    RAW_HEADERS = studentsParsed.fields || [];
    const RAW_STUDENTS = studentsParsed.data;

    const companyHeaderKey = (companiesParsed.fields || [])[0];
    COMPANIES = companiesParsed.data
      .map(r => (r[companyHeaderKey] || "").trim())
      .filter(Boolean);

    NAME_KEY = findHeader(/full ?name|^name$/i) || RAW_HEADERS[0];
    UNIVERSITY_KEY = findHeader(/university|institute|college/i);
    EMAIL_KEY = findHeader(/email/i);
    PHONE_KEY = findHeader(/phone|mobile|contact number/i);
    CONTACT_KEYS = [EMAIL_KEY, PHONE_KEY].filter(Boolean);

    PROGRAM_KEY = findHeader(/program|department|branch|major/i);
    GRADYEAR_KEY = findHeader(/grad(uation)? ?year/i);
    CITY_KEY = findHeader(/current city|^city$/i);
    TECHSTACK_KEY = findHeader(/tech ?stack/i);
    WHY_KEY = findHeader(/why.*(fellowship|polaris|apply)/i);
    PROUD_KEY = findHeader(/proud|achievement.*(impact|measurable)/i);
    BESTPROJECT_KEY = findHeader(/best project/i);
    SELFTAUGHT_KEY = findHeader(/taught yourself|self.?taught/i);
    REPOEXPLAIN_KEY = findHeader(/explain.*repo|repo.*explain|briefly explain/i);
    DEBUG_KEY = findHeader(/debug/i);
    VALIDATION_KEY = findHeader(/validation/i);
    AI_PERSONA_KEY = findHeader(/ai persona/i);

    STUDENTS = buildStudents(RAW_STUDENTS);
  }

  /* ---------------- Storage: shared backend + personal localStorage ----------------
     window.storage only exists inside Claude.ai's artifact preview — it does not
     exist once this page is deployed on its own hosting, so it can't be used here.
     Shared data (shortlists, visible to every company) now goes through a small
     Google Apps Script Web App backed by a "Shortlists" tab in the same Sheet.
     Personal data (which company this browser is signed in as) uses localStorage,
     which works normally on a real deployed page and persists across refreshes.

     ⚠️ SETUP REQUIRED: paste your deployed Apps Script Web App URL below.
     See APPS_SCRIPT_SETUP.md for the exact code to deploy and where to get this URL. */
  const SHORTLIST_API_URL = "https://script.google.com/macros/s/AKfycbyWUT0Bv0QPaFoM0MK6g_1spXNFW768GzW64VpLxsu1HRoonbCkL48HH2HrJkjegS9j/exec";
                            
  const COMPANY_PREF_KEY = "polaris_r3_current_company";

  let shortlists = {}; // { studentId: [companyName, ...] } — currently active only
  let removedHistory = {}; // { studentId: [companyName, ...] } — shortlisted, then later removed
  let currentCompany = null;
  let backendReady = SHORTLIST_API_URL.indexOf("PASTE_YOUR") === -1;

  let shortlistEpoch = 0; // bumped on every local mutation; stale responses older than this are discarded

  function applyShortlistResponse(data){
    if (!data) return;
    // Backward-compatible: older backend versions returned a flat map with no
    // active/removed split — treat that whole thing as the active set.
    if (data.active || data.removed) {
      shortlists = data.active || {};
      removedHistory = data.removed || {};
    } else {
      shortlists = data;
    }
  }

  async function loadShortlists(){
    if (!backendReady) return; // no backend configured yet — keep whatever's in memory
    try {
      const res = await fetch(SHORTLIST_API_URL, { method: "GET", cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      applyShortlistResponse(await res.json());
    } catch (e) {
      console.error("Could not load shortlists from backend — keeping last known state.", e);
      // Deliberately does NOT reset shortlists to {} on failure, so a flaky network
      // request can't wipe out what's already shown on screen.
    }
  }

  /** Sends one add/remove change to the backend. Returns the parsed response
   *  (or null on failure) WITHOUT applying it — the caller decides whether to
   *  apply it, so a stale response can't stomp on a newer local change. */
  async function pushShortlistChangeRaw(studentId, company, action, studentName){
    if (!backendReady) {
      console.error("SHORTLIST_API_URL isn't set yet — this change will NOT be saved. See APPS_SCRIPT_SETUP.md.");
      return null;
    }
    try {
      const res = await fetch(SHORTLIST_API_URL, {
        method: "POST",
        // text/plain avoids a CORS preflight (OPTIONS) request, which Apps Script
        // Web Apps don't handle — this keeps the request a "simple" CORS request.
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ studentId, company, action, studentName: studentName || "" })
      });
      if (res.ok) return await res.json();
    } catch (e) {
      console.error("Could not save shortlist change to backend", e);
    }
    return null;
  }

  const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes of inactivity
  const LAST_ACTIVE_KEY = "polaris_r3_last_active";

  function loadCompanyPref(){
    try {
      const v = localStorage.getItem(COMPANY_PREF_KEY);
      const lastActiveRaw = localStorage.getItem(LAST_ACTIVE_KEY);
      const lastActive = lastActiveRaw ? parseInt(lastActiveRaw, 10) : 0;
      const expired = !lastActive || (Date.now() - lastActive) > SESSION_TIMEOUT_MS;

      if (v && COMPANIES.includes(v) && !expired) {
        currentCompany = v;
        touchActivity(); // extend the session now that they're back
        return true;
      }
      if (v && expired) {
        // Session timed out — clear it so the gate shows fresh, not stale.
        localStorage.removeItem(COMPANY_PREF_KEY);
        localStorage.removeItem(LAST_ACTIVE_KEY);
      }
    } catch (e) { /* localStorage unavailable (e.g. private mode) — identity just won't persist */ }
    return false;
  }

  function saveCompanyPref(){
    try {
      localStorage.setItem(COMPANY_PREF_KEY, currentCompany);
      localStorage.setItem(LAST_ACTIVE_KEY, String(Date.now()));
    } catch (e) { /* ignore */ }
  }

  /** Call on this  any real user interaction to keep the 30-minute session alive. */
  let lastActivityWrite = 0;
  function touchActivity(){
    if (!currentCompany) return;
    const now = Date.now();
    if (now - lastActivityWrite < 15000) return; // throttle localStorage writes to ~1/15s
    lastActivityWrite = now;
    try { localStorage.setItem(LAST_ACTIVE_KEY, String(now)); } catch (e) { /* ignore */ }
  }

  /** Runs periodically; signs the company out only after 30 real minutes of no clicks/keys. */
  function checkSessionTimeout(){
    if (!currentCompany) return;
    try {
      const lastActiveRaw = localStorage.getItem(LAST_ACTIVE_KEY);
      const lastActive = lastActiveRaw ? parseInt(lastActiveRaw, 10) : Date.now();
      if (Date.now() - lastActive > SESSION_TIMEOUT_MS) {
        exitCompany("timeout");
      }
    } catch (e) { /* ignore */ }
  }

  document.addEventListener("click", touchActivity, { passive: true });
  document.addEventListener("keydown", touchActivity, { passive: true });

  function shortlistersFor(studentId){
    return shortlists[studentId] || [];
  }

  async function toggleShortlist(studentId){
    if (!currentCompany) { showIdentityGate(); return; }
    const s = STUDENTS.find(x => x.id === studentId);
    const list = shortlists[studentId] || [];
    const action = list.includes(currentCompany) ? "remove" : "add";

    // Optimistic update so the click feels instant, then reconcile with the server's
    // authoritative response — guarded by an epoch so an in-flight response that's
    // now stale (a newer click happened while this one was still saving) gets
    // discarded instead of flickering the UI back to the wrong state.
    shortlistEpoch++;
    const myEpoch = shortlistEpoch;
    shortlists[studentId] = action === "add" ? [...list, currentCompany] : list.filter(c => c !== currentCompany);
    renderAll();

    const updated = await pushShortlistChangeRaw(studentId, currentCompany, action, s.name);
    if (updated && myEpoch === shortlistEpoch) {
      applyShortlistResponse(updated);
      renderAll();
    }
    // If a newer click happened meanwhile (myEpoch !== shortlistEpoch), that newer
    // click's own resolution is responsible for the final render — applying this
    // older response now would revert the newer, more-correct optimistic state.
  }

  /* ---------------- Rendering ---------------- */
  let activeStudentId = null;
  let searchQuery = "";
  let sortMode = "name";

  function medalFor(rank){
    if (rank === 0) return "🥇";
    if (rank === 1) return "🥈";
    if (rank === 2) return "🥉";
    return "🏅";
  }

  function renderCompanyGreeting(){
    const el = document.getElementById("company-greeting");
    if (!currentCompany) { el.innerHTML = ""; return; }
    el.innerHTML = `<span class="wave">👋</span> Hello, <b>${escapeHtml(titleCase(currentCompany))}</b> <button id="exit-btn" class="exit-link">Exit</button>`;
    const exitBtn = document.getElementById("exit-btn");
    if (exitBtn) exitBtn.addEventListener("click", () => exitCompany());
  }

  /**
   * Signs the current company out and shows the "who are you?" gate again.
   * Only clears which company is "logged in" on this browser — shortlist
   * data itself lives in the shared backend and is never touched here, so if
   * the same company (or any other) picks up again later, their previous
   * choices are exactly as they left them.
   */
  function exitCompany(reason){
    const wasTimeout = reason === "timeout";
    currentCompany = null;
    try {
      localStorage.removeItem(COMPANY_PREF_KEY);
      localStorage.removeItem(LAST_ACTIVE_KEY);
    } catch (e) { /* ignore */ }
    renderAll();
    showIdentityGate(wasTimeout ? "Your session timed out after 30 minutes of inactivity — please sign in again." : null);
  }

  /* ---------------- Identity gate + welcome toast ---------------- */
  function renderIdentityGrid(){
    const grid = document.getElementById("identity-grid");
    grid.innerHTML = COMPANIES.map(c => `
      <button class="identity-btn" data-company="${escapeHtml(c)}">
        <span class="id-avatar">${escapeHtml(initials(titleCase(c)))}</span>
        ${escapeHtml(titleCase(c))}
      </button>
    `).join("");
    grid.querySelectorAll(".identity-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        chooseCompany(btn.getAttribute("data-company"));
      });
    });
  }

  function showIdentityGate(message){
    const sub = document.getElementById("identity-sub");
    if (sub) {
      sub.textContent = message || "Select your company to see and manage its shortlist.";
      sub.classList.toggle("timeout-notice", !!message);
    }
    document.getElementById("identity-overlay").classList.remove("hidden");
  }
  function hideIdentityGate(){
    document.getElementById("identity-overlay").classList.add("hidden");
  }

  /* ---------------- How-to-use popup ---------------- */
  const HOWTO_SEEN_KEY = "polaris_r3_howto_seen";

  function showHowTo(){
    document.getElementById("howto-overlay").classList.remove("hidden");
  }
  function hideHowTo(){
    document.getElementById("howto-overlay").classList.add("hidden");
  }
  function markHowToSeen(){
    try { localStorage.setItem(HOWTO_SEEN_KEY, "1"); } catch (e) { /* ignore */ }
  }
  function maybeShowHowToOnce(){
    let seen = false;
    try { seen = localStorage.getItem(HOWTO_SEEN_KEY) === "1"; } catch (e) { seen = false; }
    if (!seen) showHowTo();
  }

  document.getElementById("help-fab").addEventListener("click", showHowTo);
  document.getElementById("howto-close").addEventListener("click", () => {
    hideHowTo();
    markHowToSeen();
  });

  let toastTimer = null;
  function showWelcomeToast(company, isWelcomeBack){
    const toast = document.getElementById("welcome-toast");
    const text = document.getElementById("welcome-toast-text");
    text.textContent = `${isWelcomeBack ? "Welcome back" : "Welcome"}, ${titleCase(company)}!`;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 2400);
  }

  async function chooseCompany(company){
    currentCompany = company;
    await saveCompanyPref();
    hideIdentityGate();
    showWelcomeToast(company, false);
    renderAll();
    maybeShowHowToOnce();
  }

  function getFilteredSortedStudents(){
    let list = STUDENTS.slice();
    const q = searchQuery.trim().toLowerCase();
    if (q) {
      list = list.filter(s => {
        const haystack = [
          s.name, s.university,
          ...s.shortFields.map(f => f.value),
          ...s.longTexts.map(f => f.value),
          ...(s.categories || [])
        ].join(" ").toLowerCase();
        return haystack.includes(q);
      });
    }
    if (sortMode === "name") {
      list.sort((a, b) => a.name.localeCompare(b.name));
    } else if (sortMode === "university") {
      list.sort((a, b) => (a.university || "").localeCompare(b.university || ""));
    } else if (sortMode === "shortlists") {
      list.sort((a, b) => shortlistersFor(b.id).length - shortlistersFor(a.id).length || a.name.localeCompare(b.name));
    }
    return list;
  }

  function renderTable(){
    const table = document.getElementById("shortlist-table");
    const countSub = document.getElementById("student-count-sub");
    const list = getFilteredSortedStudents();
    countSub.textContent = `${list.length} of ${STUDENTS.length} candidates`;

    const theadRow = `
      <tr>
        <th class="name-col">Name / Company →</th>
        ${COMPANIES.map(c => `<th class="${c === currentCompany ? "me-col" : ""}">${escapeHtml(titleCase(c))}</th>`).join("")}
      </tr>
    `;

    if (list.length === 0) {
      table.innerHTML = `
        <thead>${theadRow}</thead>
        <tbody><tr><td class="table-no-results" colspan="${COMPANIES.length + 1}">No candidates match your search.</td></tr></tbody>
      `;
      return;
    }

    const bodyRows = list.map(s => {
      const shortlisters = shortlistersFor(s.id);
      const cells = COMPANIES.map(c => {
        const checked = shortlisters.includes(c);
        const isMe = c === currentCompany;
        const classes = ["check-cell"];
        if (isMe) classes.push("me-col");
        if (checked) classes.push("checked");
        if (isMe) classes.push("clickable");
        let title = "";
        if (isMe) title = checked ? `Remove ${s.name} from your shortlist` : `Shortlist ${s.name}`;
        return `<td class="${classes.join(" ")}" data-id="${s.id}" data-company="${escapeHtml(c)}" ${title ? `title="${escapeHtml(title)}"` : ""}>${checked ? '<span class="check-mark">✓</span>' : ""}</td>`;
      }).join("");
      return `<tr><td class="name-col" data-id="${s.id}">${escapeHtml(s.name)}</td>${cells}</tr>`;
    }).join("");

    table.innerHTML = `<thead>${theadRow}</thead><tbody>${bodyRows}</tbody>`;

    table.querySelectorAll("td.name-col").forEach(cell => {
      cell.addEventListener("click", () => openDossier(cell.getAttribute("data-id")));
    });
    table.querySelectorAll("td.check-cell.clickable").forEach(cell => {
      cell.addEventListener("click", async () => {
        await toggleShortlist(cell.getAttribute("data-id"));
      });
    });
  }

  function renderDossier(){
    const overlay = document.getElementById("overlay");
    const panel = document.getElementById("dossier");
    if (!activeStudentId) {
      overlay.classList.remove("open");
      return;
    }
    const s = STUDENTS.find(x => x.id === activeStudentId);
    if (!s) { overlay.classList.remove("open"); return; }

    const shortlisters = shortlistersFor(s.id);
    const alreadyDone = currentCompany ? shortlisters.includes(currentCompany) : false;
    // Note: removedHistory (who shortlisted then removed a candidate) is intentionally
    // NOT shown in the UI — it's tracked in the Sheet for internal visibility only,
    // not something other companies should see.

    // Contact & Details: college name instead of email/phone (those stay out of view).
    const collegeRow = s.university ? `
      <div class="contact-row"><span class="k">College</span><span class="v">${escapeHtml(s.university)}</span></div>
    ` : "";

    const shortFieldRows = s.shortFields.map(f => `
      <div class="contact-row"><span class="k">${escapeHtml(f.label)}</span><span class="v">${escapeHtml(f.value)}</span></div>
    `).join("");

    const linkButtons = s.links.map(l => `
      <a class="link-btn" href="${escapeHtml(l.url)}" target="_blank" rel="noopener noreferrer">
        ${escapeHtml(l.label)} <span class="arrow">↗</span>
      </a>
    `).join("");

    const a = s.analysis || {};

    const categoryChips = (s.categories || []).map(c => `<span class="tag-chip focus-chip">${escapeHtml(c)}</span>`).join("");

    const highlightItems = (a.highlights || []).map(h => `
      <div class="highlight-item">
        <span class="highlight-icon">${h.icon || "✦"}</span>
        <span class="highlight-text">${escapeHtml(h.text)}</span>
      </div>
    `).join("");

    const skillGroups = Object.entries(a.techCategories || {})
      .filter(([, items]) => items && items.length)
      .map(([cat, items]) => `
        <div class="skill-group">
          <span class="skill-group-label">${escapeHtml(cat)}</span>
          <div class="skill-chips">${items.map(i => `<span class="tag-chip skill-chip">${escapeHtml(i)}</span>`).join("")}</div>
        </div>
      `).join("");

    panel.innerHTML = `
      <div class="dossier-head">
        <button class="dossier-close" id="dossier-close">✕</button>
        <div class="dossier-head-inner">
          <p class="dossier-eyebrow">Candidate Dossier</p>
          <p class="dossier-name">${escapeHtml(s.name)}</p>
          ${s.university ? `<p class="dossier-uni">${escapeHtml(s.university)}</p>` : ""}
        </div>
      </div>
      <div class="dossier-body">

        <div class="dossier-shortlist-box">
          <div class="dossier-shortlist-top">
            <span class="mono" style="font-size:12px;color:var(--ink-soft);">
              ${shortlisters.length > 0 ? `Shortlisted by ${shortlisters.length} compan${shortlisters.length === 1 ? "y" : "ies"}` : "Not shortlisted yet"}
            </span>
            <button class="shortlist-btn ${alreadyDone ? "shortlisted" : ""}" id="dossier-shortlist-btn">
              ${alreadyDone ? "✓ Shortlisted — click to remove" : (currentCompany ? `Shortlist as ${escapeHtml(titleCase(currentCompany))}` : "Shortlist")}
            </button>
          </div>
          ${shortlisters.length > 0 ? `<div class="companies-list"><b>Companies:</b> ${shortlisters.map(c => escapeHtml(titleCase(c))).join(", ")}</div>` : ""}
        </div>

        ${(collegeRow || shortFieldRows) ? `
        <div class="field-group">
          <h3>Contact & Details</h3>
          <div class="contact-rows">${collegeRow}${shortFieldRows}</div>
        </div>` : ""}

        ${linkButtons ? `
        <div class="field-group">
          <h3>Links</h3>
          <div class="link-buttons">${linkButtons}</div>
        </div>` : ""}

        ${a.summary ? `
        <div class="field-group">
          <h3>Professional Summary</h3>
          <p class="summary-text">${escapeHtml(a.summary)}</p>
          ${categoryChips ? `<div class="tag-row" style="margin-top:10px;">${categoryChips}</div>` : ""}
        </div>` : ""}

        ${highlightItems ? `
        <div class="field-group">
          <h3>Key Highlights</h3>
          <div class="highlight-list">${highlightItems}</div>
        </div>` : ""}

        ${skillGroups ? `
        <div class="field-group">
          <h3>Technical Skills</h3>
          <div class="skill-groups">${skillGroups}</div>
        </div>` : ""}

      </div>
    `;

    document.getElementById("dossier-close").addEventListener("click", closeDossier);
    const dBtn = document.getElementById("dossier-shortlist-btn");
    if (dBtn) {
      dBtn.addEventListener("click", async () => {
        await toggleShortlist(s.id);
      });
    }

    overlay.classList.add("open");
  }

  function openDossier(id){
    activeStudentId = id;
    renderDossier();
    document.body.style.overflow = "hidden";
  }
  function closeDossier(){
    activeStudentId = null;
    renderDossier();
    document.body.style.overflow = "";
  }

  document.getElementById("overlay").addEventListener("click", (e) => {
    if (e.target.id === "overlay") closeDossier();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeDossier();
  });

  document.getElementById("search-input").addEventListener("input", (e) => {
    searchQuery = e.target.value;
    renderTable();
  });
  document.getElementById("sort-select").addEventListener("change", (e) => {
    sortMode = e.target.value;
    renderTable();
  });

  function renderAll(){
    renderCompanyGreeting();
    renderTable();
    if (activeStudentId) renderDossier();
  }

  /* ---------------- Live sync polling (so other companies' actions show up) ---------------- */
  async function pollShortlists(){
    if (!backendReady) return;
    const requestEpoch = shortlistEpoch;
    try {
      const res = await fetch(SHORTLIST_API_URL, { method: "GET", cache: "no-store" });
      if (!res.ok) return;
      const latest = await res.json();
      if (requestEpoch !== shortlistEpoch) return; // a click happened while this poll was in flight — its own response will win, discard this stale one
      const prevSnapshot = JSON.stringify({ shortlists, removedHistory });
      applyShortlistResponse(latest);
      if (JSON.stringify({ shortlists, removedHistory }) !== prevSnapshot) {
        renderAll();
      }
    } catch (e) { /* backend temporarily unreachable — keep showing last known state */ }
  }

  async function pollSheetData(){
    // Pick up edits made directly in the Google Sheet (new students, new companies, edited fields).
    try {
      const prevSnapshot = JSON.stringify({ companies: COMPANIES, students: STUDENTS });
      await loadSheetData();
      if (JSON.stringify({ companies: COMPANIES, students: STUDENTS }) !== prevSnapshot) {
        renderAll(); // renderAll also refreshes an open dossier, so nothing goes stale
      }
    } catch (e) { /* sheet temporarily unreachable — keep showing last good data */ }
  }

  /**
   * Keeps retrying in the background until the sheet data loads — never shows
   * an error screen. Detailed failures still go to the console for debugging,
   * but the person just sees "Welcome to MatchPoint by Polaris" with a spinner
   * the whole time, with an increasingly reassuring (never alarming) subtitle
   * if it's taking a while.
   */
  async function loadSheetDataWithRetry(){
    let attempt = 0;
    while (true){
      try {
        await loadSheetData();
        return;
      } catch (e) {
        attempt++;
        console.error("Sheet load attempt " + attempt + " failed — retrying.", e);
        const sub = document.querySelector("#loading-screen .welcome-sub");
        if (sub){
          sub.textContent = attempt >= 3
            ? "Still getting things ready — this is taking a little longer than usual."
            : "Getting the latest candidates ready for you.";
        }
        const delay = Math.min(1500 * attempt, 8000); // gentle backoff, capped at 8s
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  async function init(){
    await loadSheetDataWithRetry(); // never throws — keeps trying until it succeeds
    if (!backendReady){
      console.warn("SHORTLIST_API_URL is not configured — shortlists will NOT be saved and will disappear on refresh. See APPS_SCRIPT_SETUP.md.");
      const banner = document.createElement("div");
      banner.textContent = "⚠️ Shortlist saving isn't configured yet — changes won't be saved. See APPS_SCRIPT_SETUP.md.";
      banner.style.cssText = "position:fixed;top:0;left:0;right:0;background:#B23A2E;color:#fff;text-align:center;padding:8px;font:600 12.5px 'JetBrains Mono',monospace;z-index:999;";
      document.body.prepend(banner);
    }
    renderIdentityGrid();
    await loadShortlists();
    loadCompanyPref();
    renderAll();
    document.getElementById("loading-screen").style.display = "none";
    if (currentCompany) {
      showWelcomeToast(currentCompany, true);
      maybeShowHowToOnce();
    } else {
      showIdentityGate();
    }
    setInterval(pollShortlists, 4000);
    setInterval(pollSheetData, REFRESH_MS);
    setInterval(checkSessionTimeout, 60000);
  }

  init();
})();