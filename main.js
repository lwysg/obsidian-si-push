/**
 * SiPush — Obsidian ↔ 思源笔记 双向同步插件 (V2.0.0)
 * 纯 JS 编写，零构建，直接放入插件目录即可使用
 *
 * V2 新增：双向同步 / 批量同步 / 冲突解决 / 搜索拉回 / 同步报告
 * 思源 Kernel API: http://localhost:6806 (可自定义)
 */
const {
  Plugin, PluginSettingTab, Setting, Notice, Modal,
  MarkdownView, requestUrl, TFile
} = require("obsidian");

// ═══════════════════════════════════════════════════════════════════
// 默认设置
// ═══════════════════════════════════════════════════════════════════
const DEFAULT_SETTINGS = {
  // V1
  serverUrl: "http://127.0.0.1:6806",
  apiToken: "",
  defaultNotebookId: "",
  defaultPath: "/Obsidian/",
  pushFrontmatter: false,
  docMapping: {},
  // V2
  syncConflictMode: "ask", // ask | obsidian-wins | siyuan-wins
  maxSyncHistory: 100,
  syncHistory: [],
};

const HASH_ATTR = "si-push-content-hash";
const MTIME_ATTR = "si-push-mtime";
const PUSH_ID_KEY = "custom-si-push-id";

// ═══════════════════════════════════════════════════════════════════
// 工具函数
// ═══════════════════════════════════════════════════════════════════
function contentHash(text) {
  // 规范化内容再哈希：统一换行符，去除尾部空白，剥离思源自动添加的标题行
  const normalized = text
    .replace(/\r\n/g, "\n").replace(/\r/g, "\n")
    .replace(/\s+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^# .*\n*/, "") // 剥离第一行标题（思源 exportMdContent 自动添加），同时清除残留换行
    .trim();
  let h = 2166136261 >>> 0;
  for (let i = 0; i < normalized.length; i++) {
    h ^= normalized.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  return h.toString(16);
}

// 剥离思源 exportMdContent 自动添加的第一行标题
function stripSiTitle(text) {
  return text.replace(/^# .*\n/, "");
}
function utcSec() { return Math.floor(Date.now() / 1000); }
function formatTime(sec) {
  const d = new Date(sec * 1000);
  return d.toLocaleString("zh-CN", { hour12: false });
}
function genPushId() {
  return "si" + Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
}
function safeTitle(t) { return t.replace(/[<>:"/\\|?*]/g, "_"); }
function stripFM(c) { return c.replace(/^---[\s\S]*?---\n*/g, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\s+$/gm, "").trim(); }

/** 思源 updated 格式 "YYYYMMDDHHMMSS" → 毫秒时间戳 */
function siYuanTimeToMs(timeStr) {
  if (!timeStr) return 0;
  const s = String(timeStr).replace(/[^0-9]/g, "");
  if (s.length !== 14) return 0;
  // 解析为本地时间
  const y = parseInt(s.substring(0, 4));
  const m = parseInt(s.substring(4, 6)) - 1;
  const d = parseInt(s.substring(6, 8));
  const h = parseInt(s.substring(8, 10));
  const mi = parseInt(s.substring(10, 12));
  const sec = parseInt(s.substring(12, 14));
  const dt = new Date(y, m, d, h, mi, sec);
  return dt.getTime();
}

/** 思源 exportMdContent 返回的 Markdown 中含有思源自己的 frontmatter，需要剥离 */
function stripSiYuanFrontmatter(content) {
  if (!content) return "";
  // 移除思源自带的 frontmatter（title/date/lastmod 等）
  let stripped = content.replace(/^---[\s\S]*?lastmod:.*?\n---\s*\n/gm, "");
  // 如果上面没匹配到，试试更通用的 frontmatter 剥离
  if (stripped === content) {
    stripped = content.replace(/^---[\s\S]*?---\n*/g, "").trim();
  }
  // 也剥离思源自带的标题行（# Title），确保 getDocMd 返回纯净 body
  stripped = stripped.replace(/^# .*\n*/, "").trim();
  // 规范化：统一换行符，去除尾部空白
  return stripped.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\s+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
}

// ═══════════════════════════════════════════════════════════════════
// SiYuan API 封装 (V2 修复版)
// ═══════════════════════════════════════════════════════════════════
class SiYuanApi {
  constructor(url, token) {
    this.url = url.replace(/\/+$/, "");
    this.token = token;
  }

  async request(endpoint, payload) {
    const headers = { "Content-Type": "application/json" };
    if (this.token) headers["Authorization"] = "Token " + this.token;
    let resp;
    try {
      resp = await fetch(this.url + endpoint, {
        method: "POST", headers, body: JSON.stringify(payload),
      });
    } catch (e) {
      throw new Error("无法连接思源: " + e.message);
    }
    // 只跳过 204 No Content（无响应体），不做 Content-Length 判断
    // 浏览器在 gzip/分块编码时可能不暴露 Content-Length，导致误判为空
    if (resp.status === 204) {
      return {};
    }
    let text = "";
    try { text = await resp.text(); } catch { /* ignore */ }
    if (!text || text.trim() === "") {
      return {};
    }
    try {
      const j = JSON.parse(text);
      if (j.code !== 0) {
        throw new Error("SiYuan API: " + (j.msg || "code=" + j.code));
      }
      return j.data || j;
    } catch (e) {
      // JSON 解析失败 — 可能是 removeBlock 返回了非标准响应
      console.log(`[SiPush] JSON parse failed for ${endpoint}:`, text.substring(0, 200));
      if (e.message && e.message.includes("SiYuan")) throw e;
      // 对已知的 "轻量" API（删除操作），忽略 JSON 解析错误
      if (endpoint.includes("removeBlock") || endpoint.includes("removeDoc")) {
        return {};
      }
      throw new Error("无法连接思源: " + e.message);
    }
  }

  // ── 基础 ──
  async getNotebooks() {
    const d = await this.request("/api/notebook/lsNotebooks", {});
    return d.notebooks || d;
  }

  async createDoc(notebookId, path, md) {
    return this.request("/api/filetree/createDocWithMd", { notebook: notebookId, path, markdown: md });
  }

  async updateDoc(docId, md) {
    return this.request("/api/block/updateBlock", { id: docId, dataType: "markdown", data: md });
  }

  async appendToDoc(docId, content) {
    return this.request("/api/block/appendBlock", { parentID: docId, data: content, domain: 0 });
  }

  async setAttrs(id, attrs) { return this.request("/api/attr/setBlockAttrs", { id, attrs }); }

  async getAttrs(id) { return this.request("/api/attr/getBlockAttrs", { id }); }

  // ── 查找文档（带 updated 时间戳） ──
  async findDoc(pushId) {
    const stmt =
      "SELECT b.id, b.hpath, b.box, b.updated FROM blocks b " +
      "JOIN attributes a ON a.block_id = b.id " +
      "WHERE a.name='custom-si-push-id' AND a.value='" + pushId.replace(/'/g,"''") + "' " +
      "AND b.type='d' ORDER BY b.updated DESC LIMIT 1";
    const d = await this.request("/api/query/sql", { stmt });
    return d && d.length > 0 ? d[0] : null;
  }

  // ── 获取文档的同步元信息 ──
  async getSyncInfo(docId) {
    const a = await this.getAttrs(docId);
    return {
      hash: a[HASH_ATTR] || null,
      mtime: parseInt(a[MTIME_ATTR]) || 0,
      // 思源文档的 updated 时间戳
      updatedMs: siYuanTimeToMs(a.updated) || 0,
    };
  }

  // ── 写入同步元信息 ──
  async setSyncInfo(docId, hash, mtime) {
    return this.setAttrs(docId, { [HASH_ATTR]: hash, [MTIME_ATTR]: String(mtime) });
  }

  // ── 获取文档完整 Markdown（使用 exportMdContent API） ──
  async getDocMd(docId) {
    // 使用思源官方的 exportMdContent API 获取完整 Markdown
    const result = await this.request("/api/export/exportMdContent", { id: docId });
    if (!result || !result.content) return "";
    // 剥离思源自带的 frontmatter
    return stripSiYuanFrontmatter(result.content);
  }

  // ── 搜索 ──
  async searchDoc(kw, nb) {
    const f = nb ? "AND box='" + nb.replace(/'/g,"''") + "'" : "";
    const k = kw.replace(/'/g,"''");
    const stmt =
      "SELECT b.id, b.content, b.hpath, b.path, b.updated FROM blocks b " +
      "WHERE b.type='d' AND (b.content LIKE '%" + k + "%' OR b.hpath LIKE '%" + k + "%')" +
      f + " ORDER BY b.updated DESC LIMIT 30";
    return { blocks: await this.request("/api/query/sql", { stmt }) };
  }

  async searchLinked(nb) {
    const f = nb ? "AND b.box='" + nb.replace(/'/g,"''") + "'" : "";
    const stmt =
      "SELECT DISTINCT b.id, b.hpath, b.path, b.updated, a.value as push_id FROM blocks b " +
      "JOIN attributes a ON a.block_id=b.id " +
      "WHERE a.name='custom-si-push-id' AND b.type='d' " +
      f + " ORDER BY b.updated DESC LIMIT 200";
    return await this.request("/api/query/sql", { stmt });
  }

  // ── 删除思源文档（用 removeDoc 按路径删除，彻底删除） ──
  async removeDoc(notebookId, path) {
    // removeDoc 需要文件树路径，如 /Obsidian/推送原测试
    const p = path ? path.replace(/^[\/]/, "") : "";
    return this.request("/api/filetree/removeDoc", { notebook: notebookId, path: p });
  }
  async removeBlock(id) { return this.request("/api/block/removeBlock", { id }); }
}

// ═══════════════════════════════════════════════════════════════════
// 冲突解决弹窗
// ═══════════════════════════════════════════════════════════════════
class ConflictModal extends Modal {
  constructor(app, obsMd, siMd, title) {
    super(app); this.obsMd = obsMd; this.siMd = siMd; this.title = title;
    this._resolve = null;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("si-push-conflict-modal");
    contentEl.createEl("h2", { text: "⚠️ 同步冲突" });
    contentEl.createEl("p", { cls: "si-push-conflict-desc", text: `"${this.title}" 在 Obsidian 和思源中都修改过。` });
    const panes = contentEl.createDiv({ cls: "si-push-conflict-panes" });
    const p1 = panes.createDiv({ cls: "si-push-conflict-pane" });
    p1.createEl("h3", { text: "📝 Obsidian" });
    p1.createEl("pre", { text: this.obsMd.substring(0, 500) + (this.obsMd.length > 500 ? "\n...[截断]" : "") });
    const p2 = panes.createDiv({ cls: "si-push-conflict-pane" });
    p2.createEl("h3", { text: "📓 思源笔记" });
    const cleanSiMd = this.siMd ? stripSiTitle(this.siMd) : "";
    const siPreview = cleanSiMd ? (cleanSiMd.substring(0, 500) + (cleanSiMd.length > 500 ? "\n...[截断]" : "")) : "(思源文档无内容或已删除)";
    p2.createEl("pre", { text: siPreview });
    const acts = contentEl.createDiv({ cls: "si-push-conflict-actions" });
    const b1 = acts.createEl("button", { text: "📝 保留 Obsidian", cls: "mod-cta" });
    b1.onclick = () => { if (this._resolve) this._resolve("obsidian"); this.close(); };
    const b2 = acts.createEl("button", { text: "📓 保留思源", cls: "mod-cta" });
    b2.style.marginLeft = "8px"; b2.onclick = () => { if (this._resolve) this._resolve("siyuan"); this.close(); };
    const b3 = acts.createEl("button", { text: "取消" });
    b3.style.marginLeft = "8px"; b3.onclick = () => { if (this._resolve) this._resolve("cancel"); this.close(); };
  }
  onClose() { this.contentEl.empty(); if (this._resolve) this._resolve("cancel"); }
  openAndResolve() { return new Promise(r => { this._resolve = r; this.open(); }); }
}

// ═══════════════════════════════════════════════════════════════════
// 同步报告弹窗
// ═══════════════════════════════════════════════════════════════════
class SyncReportModal extends Modal {
  constructor(app, results) { super(app); this.results = results; }
  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("si-push-search-modal");
    contentEl.createEl("h2", { text: "🔄 同步报告" });
    const r = this.results;
    const total = r.synced + r.failed + r.conflicts;
    const s = contentEl.createDiv();
    s.style.textAlign = "center"; s.style.padding = "16px";
    const html = `<p style="font-size:18px;font-weight:600">共 ${total} 篇</p><p>✅ 已同步 ${r.synced} &nbsp; ⚠️ 冲突 ${r.conflicts} &nbsp; ❌ 失败 ${r.failed}` +
      (r.deleted > 0 ? ` &nbsp; 🗑️ 已删除 ${r.deleted}` : "") + `</p>`;
    s.innerHTML = html;
    if (r.details && r.details.length) {
      const list = contentEl.createEl("ul", { cls: "si-push-doc-list" });
      list.style.maxHeight = "280px"; list.style.overflowY = "auto";
      for (const d of r.details) {
        const li = list.createEl("li", { cls: "si-push-doc-item" });
        const ic = d.status === "success" ? "✅" : d.status === "conflict" ? "⚠️" : d.status === "deleted" ? "🗑️" : "❌";
        li.createEl("div", { text: ic + " " + d.title });
        li.createEl("div", { cls: "si-push-doc-preview", text: d.direction + (d.detail ? " — " + d.detail : "") });
      }
    }
    const cb = contentEl.createEl("button", { text: "关闭", cls: "mod-cta" });
    cb.style.cssText = "display:block;margin:12px auto";
    cb.onclick = () => this.close();
  }
  onClose() { this.contentEl.empty(); }
}

// ═══════════════════════════════════════════════════════════════════
// 搜索拉回弹窗
// ═══════════════════════════════════════════════════════════════════
class SearchPullModal extends Modal {
  constructor(app, api, nb) { super(app); this.api = api; this.nb = nb; this.result = null; this._resolve = null; }
  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("si-push-search-modal");
    contentEl.createEl("h2", { text: "🔍 搜索思源文档并拉回 Obsidian" });
    const inp = contentEl.createEl("input", { type: "text", placeholder: "关键词搜索（留空列全部已关联）" });
    Object.assign(inp.style, { width:"100%", margin:"8px 0", padding:"8px" });
    const box = contentEl.createDiv();
    const btn = contentEl.createEl("button", { text: "🔍 搜索", cls: "mod-cta" });
    btn.onclick = async () => {
      box.empty(); box.createEl("div", { text: "搜索中...", cls: "si-push-search-hint" });
      try {
        const kw = inp.value.trim();
        let data = kw ? (await this.api.searchDoc(kw, this.nb)).blocks : await this.api.searchLinked(this.nb);
        box.empty();
        if (!data || !data.length) { box.createEl("div", { text: "未找到", cls: "si-push-search-hint" }); return; }
        const list = box.createEl("ul", { cls: "si-push-doc-list" });
        for (const b of data) {
          const li = list.createEl("li", { cls: "si-push-doc-item" });
          li.createEl("div", { text: b.hpath || "(无路径)", cls: "si-push-doc-path" });
          li.createEl("div", { text: (b.content||"").substring(0,60), cls: "si-push-doc-preview" });
          li.onclick = () => { this.result = b; this.close(); };
        }
      } catch(e) { box.empty(); box.createEl("div", { text: "失败: " + e.message, cls: "si-push-error" }); }
    };
    inp.addEventListener("keydown", e => { if (e.key === "Enter") btn.click(); });
    inp.focus();
  }
  onClose() { this.contentEl.empty(); if (this._resolve) this._resolve(this.result); }
  openAndGetResult() { return new Promise(r => { this._resolve = r; this.open(); }); }
}

// ═══════════════════════════════════════════════════════════════════
// 主插件
// ═══════════════════════════════════════════════════════════════════
function buildPath(defaultPath, title) {
  return defaultPath.replace(/\/+$/, "") + "/" + safeTitle(title);
}

class SiPushPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.api = new SiYuanApi(this.settings.serverUrl, this.settings.apiToken);
    this.isSyncing = false;

    this.addRibbonIcon("refresh-cw", "同步当前笔记到思源", () => this.syncCurrentNote());
    this.addRibbonIcon("git-pull-request", "与思源批量双向同步", () => this.batchSync());

    this.addCommand({ id: "push-current", name: "推送当前笔记到思源", icon: "upload-cloud",
      editorCallback: () => this.pushCurrentNote() });
    this.addCommand({ id: "push-select", name: "推送选中内容到思源", icon: "upload-cloud",
      editorCallback: ed => { const s = ed.getSelection(); if(!s){ new Notice("请先选中内容"); return; } this.pushSelection(s); } });
    this.addCommand({ id: "append-doc", name: "追加到思源已有文档", icon: "upload-cloud",
      editorCallback: ed => this.appendToExisting(ed.getSelection() || ed.getValue()) });
    // V2 命令
    this.addCommand({ id: "sync-current", name: "同步当前笔记到思源", icon: "refresh-cw",
      callback: () => this.syncCurrentNote() });
    this.addCommand({ id: "sync-batch", name: "与思源批量双向同步", icon: "git-pull-request",
      callback: () => this.batchSync() });
    this.addCommand({ id: "force-push", name: "强制推送当前笔记到思源", icon: "upload-cloud",
      editorCallback: () => this.pushCurrentNote() });
    this.addCommand({ id: "pull-from-siyuan", name: "搜索思源文档并拉回", icon: "download-cloud",
      callback: () => this.pullFromSiYuan() });
    this.addCommand({ id: "test-conn", name: "测试思源连接", icon: "link",
      callback: () => this.testConnection() });

    this.addSettingTab(new SiPushSettingTab(this.app, this));
  }
  onunload() {}
  async loadSettings() { this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()); }
  async saveSettings() { await this.saveData(this.settings); this.api = new SiYuanApi(this.settings.serverUrl, this.settings.apiToken); }

  // ── 推送 (V1 保留) ──
  async pushCurrentNote() {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) { new Notice("没有打开的笔记"); return; }
    const file = view.file; if (!file) { new Notice("无法获取文件"); return; }
    const pushId = await this.getOrCreatePushId(file);
    const title = file.basename;
    let md = view.data;
    if (!this.settings.pushFrontmatter) md = stripFM(md);
    const path = buildPath(this.settings.defaultPath, title);
    await this.pushToSiYuan(file, path, md, pushId, title);
  }

  async pushSelection(text) {
    if (!this.settings.defaultNotebookId) { new Notice("请先配置默认笔记本"); return; }
    let md = text; if (!this.settings.pushFrontmatter) md = stripFM(md);
    const pushId = "si-push://" + Date.now();
    const path = buildPath(this.settings.defaultPath, "选区内容_" + Date.now().toString(36));
    try {
      const res = await this.api.createDoc(this.settings.defaultNotebookId, path, md);
      await this.api.setAttrs(res, { "custom-si-push-id": pushId, title: path.split("/").pop() });
      new Notice("✅ 选区推送成功！");
    } catch(e) { new Notice("❌ 推送失败: " + e.message, 6000); }
  }

  async appendToExisting(content) {
    if (!this.settings.defaultNotebookId) { new Notice("请先配置默认笔记本"); return; }
    const m = new SearchPullModal(this.app, this.api, this.settings.defaultNotebookId);
    const doc = await m.openAndGetResult();
    if (!doc) { new Notice("已取消"); return; }
    let md = content; if (!this.settings.pushFrontmatter) md = stripFM(md);
    new Notice("正在追加...");
    try { await this.api.appendToDoc(doc.id, md.trim()); new Notice("✅ 追加成功！"); }
    catch(e) { new Notice("❌ 追加失败: " + e.message, 6000); }
  }

  // ── V2: 单笔记双向同步 ──
  async syncCurrentNote() {
    if (this.isSyncing) { new Notice("同步进行中..."); return; }
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) { new Notice("没有打开的笔记"); return; }
    const file = view.file; if (!file) { new Notice("无法获取文件"); return; }
    const pushId = await this.getOrCreatePushId(file);
    if (!pushId) return;
    this.isSyncing = true;
    new Notice("正在双向同步...");
    try {
      const result = await this.syncNote(file, pushId, file.basename);
      console.log("[SiPush] sync result:", result);
    } catch(e) { new Notice("❌ 同步出错: " + e.message, 6000); }
    this.isSyncing = false;
  }

  // ── V2: 批量双向同步 ──
  async batchSync() {
    if (this.isSyncing) { new Notice("同步进行中..."); return; }
    if (!this.settings.defaultNotebookId) { new Notice("请先配置默认笔记本"); return; }
    this.isSyncing = true;
    new Notice("正在批量同步，请稍候...");

    const results = { synced: 0, failed: 0, conflicts: 0, deleted: 0, details: [] };
    const files = this.app.vault.getMarkdownFiles();
    const mapped = [];
    for (const f of files) {
      const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
      if (fm && fm[PUSH_ID_KEY]) mapped.push({ file: f, pushId: fm[PUSH_ID_KEY] });
    }
    console.log("[SiPush V2] 找到 " + mapped.length + " 篇关联笔记");

    // 构建 Obsidian 侧 pushId 集合（用于判断遗弃）
    const obsPushIds = new Set(mapped.map(m => m.pushId));

    // 同步 Obsidian 笔记 → 思源
    for (const { file, pushId } of mapped) {
      try {
        const title = file.basename;
        const result = await this.syncNote(file, pushId, title);
        if (result === "success") { results.synced++; results.details.push({ title, status: "success", direction: "已同步" }); }
        else if (result === "conflict") { results.conflicts++; results.details.push({ title, status: "conflict", direction: "冲突" }); }
        else { results.failed++; results.details.push({ title, status: "error", direction: "失败" }); }
      } catch(e) {
        results.failed++;
        results.details.push({ title: file.basename, status: "error", direction: "异常", detail: e.message.substring(0, 50) });
      }
    }

    // 清理思源侧被遗弃的文档：有 push-id 但 Obsidian 已删除
    try {
      const siDocs = await this.api.searchLinked(this.settings.defaultNotebookId);
      const deletedPushIds = new Set();
      for (const d of siDocs) {
        // 跳过本轮已删除的（防止反复删除）
        if (deletedPushIds.has(d.push_id)) continue;
        if (!obsPushIds.has(d.push_id)) {
          // 先验证文档是否还存在于文件树中（已删除但 blocks 表残留的记录要跳过）
          let docExists = false;
          try {
            const content = await this.api.getDocMd(d.id);
            if (content && content.length > 0) docExists = true;
          } catch(e) {
            docExists = false;
          }
          if (!docExists) {
            // 文档已不存在于文件树，无需删除，静默跳过
            console.log("[SiPush V2] 跳过已删除文档: " + (d.hpath || "(无路径)"));
            deletedPushIds.add(d.push_id);
            continue;
          }

          let deleteSuccess = false;
          // 优先用 removeDoc（彻底删除文件树节点），失败则 fallback 到 removeBlock
          try {
            if (d.path) {
              await this.api.removeDoc(this.settings.defaultNotebookId, d.path);
              deleteSuccess = true;
            }
          } catch(e) {
            console.log("[SiPush V2] removeDoc failed for " + d.hpath + ": " + e.message.substring(0, 50) + ", trying removeBlock...");
            try {
              await this.api.removeBlock(d.id);
              deleteSuccess = true;
            } catch(e2) {
              console.log("[SiPush V2] removeBlock also failed for " + d.hpath + ": " + e2.message.substring(0, 50));
            }
          }
          if (deleteSuccess) {
            // 标记已删除，防止本轮后续重复处理
            deletedPushIds.add(d.push_id);
            results.deleted++;
            results.details.push({ title: d.hpath || "(无路径)", status: "deleted", direction: "已删除(遗弃)" });
            console.log("[SiPush V2] 已删除废弃文档: " + d.hpath);
          } else {
            results.details.push({ title: d.hpath || "(无路径)", status: "error", direction: "删除失败", detail: "API 均失败" });
          }
        }
      }
    } catch(e) {
      console.error("[SiPush V2] 清理废弃文档失败:", e.message);
    }

    this.isSyncing = false;
    const modal = new SyncReportModal(this.app, results);
    modal.open();
    this.logSyncHistory(results);
  }

  // ── V2: 核心同步逻辑（哈希驱动版） ──
  async syncNote(file, pushId, title) {
    // 1. 获取 Obsidian 当前内容和哈希
    let obsMd;
    try { obsMd = await this.app.vault.read(file); }
    catch(e) { console.error("[SiPush] read error:", e.message); return "error"; }

    let obsContent = obsMd;
    if (!this.settings.pushFrontmatter) obsContent = stripFM(obsMd);

    // 为哈希对比剥离标题行（与 getDocMd 的 stripSiYuanFrontmatter 行为一致）
    // obsContent 保留标题用于推送，obsHashContent 用于哈希对比
    let obsHashContent = obsContent.replace(/^# .*\n*/, "").trim();
    const obsHash = contentHash(obsHashContent);

    // 2. 查找思源文档
    let siDoc;
    try { siDoc = await this.api.findDoc(pushId); }
    catch(e) { console.error("[SiPush] findDoc error:", e.message); return "error"; }

    if (!siDoc) {
      await this.pushToSiYuan(file, buildPath(this.settings.defaultPath, title), obsContent, pushId, title);
      return "success";
    }

    // 3. 获取思源当前内容和存储的同步元信息
    let siMd = "";
    try { siMd = await this.api.getDocMd(siDoc.id); }
    catch(e) { console.error("[SiPush] getDocMd error:", e.message); }

    // 思源文档存在但内容为空 → 视为已删除，直接推送覆盖
    if (!siMd && siDoc) {
      console.log(`[SiPush] "${title}": 思源文档为空（已删除）→ PUSH`);
      await this.updateSiYuanDoc(siDoc.id, obsContent, pushId, obsHash, file.mtime, title);
      return "success";
    }

    const siHash = contentHash(siMd);
    const stored = await this.api.getSyncInfo(siDoc.id);
    const storedHash = stored.hash || null;

    // 4. 内容完全一致 → 跳过
    if (siHash === obsHash) {
      console.log(`[SiPush] "${title}": 内容一致，跳过`);
      return "success";
    }

    // 5. 哈希驱动的方向判断（不依赖时间戳）
    const siChanged = storedHash ? siHash !== storedHash : false;
    const obsChanged = storedHash ? obsHash !== storedHash : false;

    if (!storedHash) {
      // 首次同步 — Obsidian 是源头，默认推送
      console.log(`[SiPush] "${title}": 首次同步 → PUSH`);
      await this.updateSiYuanDoc(siDoc.id, obsContent, pushId, obsHash, file.mtime, title);
      return "success";
    }

    if (siChanged && obsChanged) {
      // 双方都改过 → 冲突
      console.log(`[SiPush] "${title}": 冲突 (双方都改过)`);
      if (this.settings.syncConflictMode === "obsidian-wins") {
        await this.updateSiYuanDoc(siDoc.id, obsContent, pushId, obsHash, file.mtime, title);
      } else if (this.settings.syncConflictMode === "siyuan-wins") {
        await this.pullToObsidian(file, siDoc.id, pushId, title);
      } else {
        const cm = new ConflictModal(this.app, obsContent, siMd, title);
        const choice = await cm.openAndResolve();
        if (choice === "obsidian") await this.updateSiYuanDoc(siDoc.id, obsContent, pushId, obsHash, file.mtime, title);
        else if (choice === "siyuan") await this.pullToObsidian(file, siDoc.id, pushId, title);
        return "conflict";
      }
    } else if (siChanged && !obsChanged) {
      // 只有思源改过 → 拉取
      console.log(`[SiPush] "${title}": 思源修改 → PULL`);
      await this.pullToObsidian(file, siDoc.id, pushId, title);
    } else if (!siChanged && obsChanged) {
      // 只有 Obsidian 改过 → 推送
      console.log(`[SiPush] "${title}": Obsidian修改 → PUSH`);
      await this.updateSiYuanDoc(siDoc.id, obsContent, pushId, obsHash, file.mtime, title);
    }

    return "success";
  }

  // ── V2: 更新思源文档（push） ──
  async updateSiYuanDoc(docId, md, pushId, hash, mtime, title) {
    try {
      await this.api.updateDoc(docId, md);
      await this.api.setSyncInfo(docId, hash, mtime);
      await this.api.setAttrs(docId, { "custom-si-push-id": pushId, title: title });
      new Notice("📤 → 思源 ✅ 已推送: " + title);
    } catch(e) {
      console.error("[SiPush] 更新失败:", e.message);
      new Notice("❌ 更新失败: " + e.message, 6000);
      throw e;
    }
  }

  // ── V2: 拉取到 Obsidian ──
  async pullToObsidian(file, docId, pushId, title) {
    try {
      const siMd = await this.api.getDocMd(docId);
      if (!siMd) { new Notice("思源文档无内容"); return; }
      // 剥离思源自动添加的标题行
      const cleanMd = stripSiTitle(siMd);
      if (!cleanMd.trim()) { new Notice("思源文档无内容"); return; }
      // 写入 Obsidian 文件
      await this.app.vault.modify(file, cleanMd);
      // 更新 frontmatter
      await this.app.fileManager.processFrontMatter(file, fm => {
        fm[PUSH_ID_KEY] = pushId;
      });
      // 更新存储的哈希（拉取后 Obsidian 和思源内容一致）
      await this.api.setSyncInfo(docId, contentHash(siMd), file.mtime);
      new Notice("📥 ← 思源 ✅ 已拉取: " + title);
    } catch(e) {
      console.error("[SiPush] 拉取失败:", e.message);
      new Notice("❌ 拉取失败: " + e.message, 6000);
      throw e;
    }
  }

  // ── V2: 搜索拉回 ──
  async pullFromSiYuan() {
    if (!this.settings.defaultNotebookId) { new Notice("请先配置默认笔记本"); return; }
    const m = new SearchPullModal(this.app, this.api, this.settings.defaultNotebookId);
    const doc = await m.openAndGetResult();
    if (!doc) { new Notice("已取消"); return; }
    try {
      const md = await this.api.getDocMd(doc.id);
      if (!md) { new Notice("文档无内容"); return; }
      const cleanMd = stripSiTitle(md);
      if (!cleanMd.trim()) { new Notice("文档无内容"); return; }
      const safeName = safeTitle(doc.hpath.split("/").pop() || "untitled") + "_" + Date.now().toString(36).slice(-6);
      await this.app.vault.create(safeName + ".md", cleanMd);
      const newFile = this.app.vault.getAbstractFileByPath(safeName + ".md");
      if (newFile instanceof TFile) {
        await this.app.fileManager.processFrontMatter(newFile, fm => {
          fm[PUSH_ID_KEY] = genPushId();
        });
      }
      new Notice("✅ 拉回成功: " + safeName);
    } catch(e) { new Notice("❌ 拉回失败: " + e.message, 6000); }
  }

  // ── V2: 获取或生成 pushId ──
  async getOrCreatePushId(file) {
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    if (fm && fm[PUSH_ID_KEY]) return fm[PUSH_ID_KEY];
    const newId = genPushId();
    await this.app.fileManager.processFrontMatter(file, fm => { fm[PUSH_ID_KEY] = newId; });
    return newId;
  }

  // ── 内部: 推送到思源 ──
  async pushToSiYuan(file, path, md, pushId, title) {
    if (!this.settings.defaultNotebookId) { new Notice("请先配置默认笔记本"); return; }
    const hash = contentHash(md.replace(/^# .*\n*/, "").trim());
    const mtime = file ? Math.floor(file.mtime / 1000) : utcSec();
    let existingDoc = null;
    try { existingDoc = await this.api.findDoc(pushId); } catch(e) {}

    if (existingDoc) {
      try {
        await this.api.updateDoc(existingDoc.id, md);
        await this.api.setSyncInfo(existingDoc.id, hash, mtime);
        await this.api.setAttrs(existingDoc.id, { "custom-si-push-id": pushId, title: title });
        new Notice("📤 → 思源 ✅ 推送更新成功!");
      } catch(e) { new Notice("❌ 更新失败: " + e.message, 6000); }
    } else {
      try {
        const res = await this.api.createDoc(this.settings.defaultNotebookId, path, md);
        await this.api.setSyncInfo(res, hash, mtime);
        await this.api.setAttrs(res, { "custom-si-push-id": pushId, title: title });
        new Notice("📤 → 思源 ✅ 推送新建成功!");
      } catch(e) { new Notice("❌ 推送失败: " + e.message, 6000); }
    }
  }

  // ── 测试连接 ──
  async testConnection() {
    new Notice("正在测试连接...");
    try {
      const nbs = await this.api.getNotebooks();
      const lines = nbs.map(n => "  📓 " + n.name + " (" + n.id.substring(0,12) + "…)");
      new Notice("✅ 连接成功！" + nbs.length + " 个笔记本:\n" + lines.join("\n"), 8000);
    } catch(e) { new Notice("❌ 连接失败: " + e.message, 6000); }
  }

  // ── 同步历史 ──
  logSyncHistory(results) {
    const h = this.settings.syncHistory || [];
    h.unshift({ time: utcSec(), ...results });
    this.settings.syncHistory = h.slice(0, this.settings.maxSyncHistory);
    this.saveSettings();
  }
}

// ═══════════════════════════════════════════════════════════════════
// 设置页
// ═══════════════════════════════════════════════════════════════════
class SiPushSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
    this._dd = null;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "SiPush - 思源同步设置 (V2)" });

    new Setting(containerEl).setName("思源服务器地址").setDesc("Kernel API 地址")
      .addText(t => t.setPlaceholder("http://127.0.0.1:6806").setValue(this.plugin.settings.serverUrl)
        .onChange(async v => { this.plugin.settings.serverUrl = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl).setName("API Token").setDesc("思源设置 → 关于 → API Token")
      .addText(t => t.setPlaceholder("留空不使用").setValue(this.plugin.settings.apiToken)
        .onChange(async v => { this.plugin.settings.apiToken = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl).addButton(b => b.setButtonText("🔌 测试连接").onClick(() => this.plugin.testConnection()));

    new Setting(containerEl).setName("默认笔记本").setDesc("点击刷新从思源获取列表")
      .addDropdown(dd => {
        this._dd = dd;
        dd.addOption("", "-- 请刷新 --");
        if (this.plugin.settings.defaultNotebookId) dd.setValue(this.plugin.settings.defaultNotebookId);
        dd.onChange(async v => { this.plugin.settings.defaultNotebookId = v; await this.plugin.saveSettings(); });
      }).addButton(b => b.setButtonText("🔄 刷新").setCta().onClick(() => this.refresh()));

    new Setting(containerEl).setName("默认路径前缀").setDesc("思源中文档的存放路径")
      .addText(t => t.setPlaceholder("/Obsidian/").setValue(this.plugin.settings.defaultPath)
        .onChange(async v => { this.plugin.settings.defaultPath = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl).setName("保留 Frontmatter").setDesc("推送时保留 --- frontmatter --- 区域")
      .addToggle(t => t.setValue(this.plugin.settings.pushFrontmatter)
        .onChange(async v => { this.plugin.settings.pushFrontmatter = v; await this.plugin.saveSettings(); }));

    // V2 设置
    containerEl.createEl("h3", { text: "🔄 双向同步设置 (V2)" });

    new Setting(containerEl).setName("冲突解决策略").setDesc("当 Obsidian 和思源同时修改时如何处理")
      .addDropdown(dd => {
        dd.addOption("ask", "弹窗让用户选择");
        dd.addOption("obsidian-wins", "始终保留 Obsidian 版本");
        dd.addOption("siyuan-wins", "始终保留思源版本");
        dd.setValue(this.plugin.settings.syncConflictMode);
        dd.onChange(async v => { this.plugin.settings.syncConflictMode = v; await this.plugin.saveSettings(); });
      });

    const info = containerEl.createDiv({ cls: "si-push-info" });
    Object.assign(info.style, { marginTop:"24px", padding:"12px", background:"var(--background-secondary)", borderRadius:"6px" });
    info.createEl("p", { text: "💡 V2 功能说明" });
    info.createEl("ul").innerHTML = `
      <li><strong>推送</strong>：当前笔记 → 思源（已有文档原地更新）</li>
      <li><strong>🔄 双向同步当前笔记</strong>：对比时间戳 + 内容哈希，自动 push 或 pull</li>
      <li><strong>🔄 批量双向同步</strong>：遍历所有关联笔记，逐个双向同步并展示报告</li>
      <li><strong>📥 搜索思源文档并拉回</strong>：从思源搜索文档，拉取到 Obsidian</li>
      <li><strong>冲突处理</strong>：双方都修改时弹窗让用户选择保留哪边</li>
      <li>关联标记：<code>custom-si-push-id</code> 写入笔记 frontmatter</li>
    `;
  }
  async refresh() {
    const dd = this._dd; if (!dd) return;
    const api = new SiYuanApi(this.plugin.settings.serverUrl, this.plugin.settings.apiToken);
    try {
      const nbs = await api.getNotebooks();
      dd.selectEl.empty();
      dd.addOption("", "-- 请选择笔记本 --");
      for (const nb of nbs) dd.addOption(nb.id, (nb.closed?"📁 ":"📓 ") + nb.name);
      if (this.plugin.settings.defaultNotebookId) dd.setValue(this.plugin.settings.defaultNotebookId);
      new Notice("✅ 已加载 " + nbs.length + " 个笔记本");
    } catch(e) { new Notice("❌ 获取失败: " + e.message, 6000); }
  }
}

module.exports = SiPushPlugin;
