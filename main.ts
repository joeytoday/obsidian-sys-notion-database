import { App, Notice, Plugin, PluginSettingTab, Setting, Modal, TFile, normalizePath, requestUrl } from 'obsidian';

// ==================== Notion API 客户端 (使用 Obsidian requestUrl 避免 CORS) ====================

class NotionClient {
	private token: string;
	private baseUrl = 'https://api.notion.com/v1';

	constructor(token: string) {
		this.token = token;
	}

	private async request<T>(path: string, options?: { method?: string; body?: any }): Promise<T> {
		const response = await requestUrl({
			url: `${this.baseUrl}${path}`,
			method: options?.method || 'GET',
			headers: {
				'Authorization': `Bearer ${this.token}`,
				'Notion-Version': '2022-06-28',
				'Content-Type': 'application/json',
			},
			body: options?.body ? JSON.stringify(options.body) : undefined,
		});

		return response.json as T;
	}

	databases = {
		retrieve: (databaseId: string) =>
			this.request<{
				id: string;
				title: Array<{ plain_text: string }>;
				properties: Record<string, any>;
			}>(`/databases/${databaseId}`),

		query: (databaseId: string, startCursor?: string) =>
			this.request<{
				results: Array<{
					id: string;
					object: string;
					last_edited_time: string;
					properties: Record<string, any>;
				}>;
				next_cursor: string | null;
			}>(`/databases/${databaseId}/query`, {
				method: 'POST',
				body: startCursor ? { start_cursor: startCursor } : undefined,
			}),
	};
}

// ==================== 接口定义 ====================

interface NotionSyncSettings {
	notionToken: string;
	databaseId: string;
	syncFolder: string;
	propertyMappings: PropertyMapping[];
	syncRules: SyncRule[];
	fileTemplate: string;
	filenameProperty: string;
	templateFilePath: string;
}

interface PropertyMapping {
	notionProperty: string;
	notionType: string;
	obsidianProperty: string;
	enabled: boolean;
	isTemplateVariable: boolean;
}

interface SyncRule {
	property: string;
	condition: 'equals' | 'notEmpty' | 'isTrue' | 'isFalse';
	value?: string;
}

interface UpdatedFile {
	filename: string;
	oldContent: string;
	newContent: string;
}

interface SyncResult {
	created: string[];
	updated: UpdatedFile[];
	unchanged: number;
	skipped: number;
}

interface PageInfo {
	id: string;
	lastEditedTime: string;
	properties: Record<string, any>;
	title: string;
}

interface FileSelectionItem {
	page: PageInfo;
	filename: string;
	filePath: string;
	exists: boolean;
	selected: boolean;
	overwrite: boolean;
}

// ==================== 默认设置 ====================

const DEFAULT_SETTINGS: NotionSyncSettings = {
	notionToken: '',
	databaseId: '',
	syncFolder: 'Notion Sync',
	propertyMappings: [],
	syncRules: [],
	fileTemplate: '---\n{{frontmatter}}\n---\n\n# {{title}}\n\n{{content}}',
	filenameProperty: 'title',
	templateFilePath: '',
};

// ==================== 主插件类 ====================

export default class NotionSyncPlugin extends Plugin {
	settings: NotionSyncSettings;
	notionClient: NotionClient | null = null;

	async onload() {
		await this.loadSettings();
		this.initializeNotionClient();

		this.addCommand({
			id: 'sync-notion-database',
			name: 'Sync Notion Database',
			callback: async () => {
				await this.syncDatabase();
			},
		});

		this.addSettingTab(new NotionSyncSettingTab(this.app, this));
		console.log('Notion Database Sync plugin loaded');
	}

	onunload() {
		console.log('Notion Database Sync plugin unloaded');
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.initializeNotionClient();
	}

	initializeNotionClient() {
		if (this.settings.notionToken) {
			this.notionClient = new NotionClient(this.settings.notionToken);
		} else {
			this.notionClient = null;
		}
	}

	// 获取数据库属性
	async fetchDatabaseProperties(): Promise<Record<string, any> | null> {
		if (!this.notionClient || !this.settings.databaseId) return null;
		try {
			const response = await this.notionClient.databases.retrieve(this.settings.databaseId);
			return response.properties;
		} catch (error) {
			console.error('Failed to fetch database properties:', error);
			return null;
		}
	}

	// 获取所有页面
	async fetchAllPages(): Promise<PageInfo[]> {
		if (!this.notionClient || !this.settings.databaseId) return [];

		const pages: PageInfo[] = [];
		let cursor: string | undefined;

		do {
			const response = await this.notionClient.databases.query(
				this.settings.databaseId,
				cursor
			);

			for (const page of response.results) {
				const title = this.extractTitle(page.properties);
				pages.push({
					id: page.id,
					lastEditedTime: page.last_edited_time,
					properties: page.properties,
					title,
				});
			}

			cursor = response.next_cursor ?? undefined;
		} while (cursor);

		return pages;
	}

	// 提取页面标题
	extractTitle(properties: Record<string, any>): string {
		// 优先从 title 属性获取
		for (const [key, prop] of Object.entries(properties)) {
			if (prop?.type === 'title' && prop.title?.length > 0) {
				return prop.title.map((t: any) => t.plain_text).join('');
			}
		}
		return 'Untitled';
	}

	// 检查记录是否满足同步规则
	checkSyncRules(properties: Record<string, any>): boolean {
		if (this.settings.syncRules.length === 0) return true;

		return this.settings.syncRules.every(rule => {
			const prop = properties[rule.property];
			if (!prop) return false;

			const value = this.extractPropertyValue(prop);

			switch (rule.condition) {
				case 'equals':
					return String(value).toLowerCase() === String(rule.value).toLowerCase();
				case 'notEmpty':
					return value !== null && value !== undefined && value !== '';
				case 'isTrue':
					return value === true || value === 'true' || value === 'yes';
				case 'isFalse':
					return value === false || value === 'false' || value === 'no';
				default:
					return true;
			}
		});
	}

	// 提取属性值
	extractPropertyValue(prop: any): any {
		switch (prop.type) {
			case 'title':
				return prop.title?.map((t: any) => t.plain_text).join('') || '';
			case 'rich_text':
				return prop.rich_text?.map((t: any) => t.plain_text).join('') || '';
			case 'number':
				return prop.number;
			case 'select':
				return prop.select?.name || '';
			case 'multi_select':
				return prop.multi_select?.map((s: any) => s.name) || [];
			case 'checkbox':
				return prop.checkbox;
			case 'url':
				return prop.url || '';
			case 'email':
				return prop.email || '';
			case 'phone_number':
				return prop.phone_number || '';
			case 'date':
				return prop.date?.start || '';
			case 'status':
				return prop.status?.name || '';
			case 'formula':
				return prop.formula?.[prop.formula.type] || '';
			case 'rollup':
				return prop.rollup?.array || [];
			case 'relation':
				return prop.relation?.map((r: any) => r.id) || [];
			case 'created_time':
				return prop.created_time;
			case 'last_edited_time':
				return prop.last_edited_time;
			case 'created_by':
				return prop.created_by?.name || '';
			case 'last_edited_by':
				return prop.last_edited_by?.name || '';
			default:
				return '';
		}
	}

	// 生成文件名
	generateFilename(page: PageInfo): string {
		const mapping = this.settings.propertyMappings.find(
			m => m.notionProperty === this.settings.filenameProperty
		);

		let filename: string;
		if (mapping) {
			const prop = page.properties[this.settings.filenameProperty];
			filename = prop ? this.extractPropertyValue(prop) : page.title;
		} else {
			filename = page.title;
		}

		// 清理文件名中的非法字符
		return filename.replace(/[<>:"/\\|?*]/g, '_').trim() || 'Untitled';
	}

	// 生成 frontmatter
	generateFrontmatter(properties: Record<string, any>): string {
		const lines: string[] = [];
		const enabledMappings = this.settings.propertyMappings.filter(m => m.enabled);

		for (const mapping of enabledMappings) {
			const prop = properties[mapping.notionProperty];
			if (!prop) continue;

			const value = this.extractPropertyValue(prop);
			let formattedValue: string;

			if (Array.isArray(value)) {
				if (value.length === 0) continue;
				formattedValue = `[${value.map(v => `"${v}"`).join(', ')}]`;
			} else if (typeof value === 'boolean') {
				formattedValue = String(value);
			} else if (value === null || value === undefined || value === '') {
				continue;
			} else {
				formattedValue = String(value);
			}

			// 如果有特殊字符，用引号包裹
			if (/[:#\[\]{}|>&*!]/g.test(formattedValue) || formattedValue.includes('\n')) {
				formattedValue = `"${formattedValue.replace(/"/g, '\\"')}"`;
			}

			lines.push(`${mapping.obsidianProperty}: ${formattedValue}`);
		}

		// 添加元信息
		lines.push(`notion_id: ${properties.id || ''}`);
		lines.push(`notion_last_edited: ${properties.last_edited_time || ''}`);

		return lines.join('\n');
	}

	// 获取模板内容
	async getTemplateContent(): Promise<string> {
		// 如果设置了模板文件路径，优先使用文件内容
		if (this.settings.templateFilePath) {
			const file = this.app.vault.getAbstractFileByPath(this.settings.templateFilePath);
			if (file instanceof TFile) {
				try {
					return await this.app.vault.read(file);
				} catch (error) {
					console.error('读取模板文件失败:', error);
					new Notice(`读取模板文件失败: ${error.message}`);
				}
			}
		}
		// 使用默认模板
		return this.settings.fileTemplate;
	}

	// 生成文件内容
	async generateFileContent(page: PageInfo): Promise<string> {
		const frontmatter = this.generateFrontmatter(page.properties);
		let content = await this.getTemplateContent();

		// 替换模板变量
		content = content.replace('{{frontmatter}}', frontmatter);
		content = content.replace('{{title}}', page.title);
		content = content.replace('{{content}}', ''); // 内容占位符，用户可手动添加

		// 替换自定义属性变量
		this.settings.propertyMappings
			.filter(m => m.isTemplateVariable && m.enabled)
			.forEach(mapping => {
				const prop = page.properties[mapping.notionProperty];
				const value = prop ? this.extractPropertyValue(prop) : '';
				const placeholder = new RegExp(`{{${mapping.obsidianProperty}}}`, 'g');
				content = content.replace(placeholder, String(value));
			});

		return content;
	}

	// 同步数据库
	async syncDatabase(): Promise<void> {
		if (!this.notionClient) {
			new Notice('请先配置 Notion Token');
			return;
		}

		if (!this.settings.databaseId) {
			new Notice('请先配置 Database ID');
			return;
		}

		try {
			// 获取所有页面
			new Notice('正在获取 Notion 数据库页面...');
			const pages = await this.fetchAllPages();
			console.log(`Fetched ${pages.length} pages from Notion`);

			// 确保同步文件夹存在
			const folderPath = normalizePath(this.settings.syncFolder);
			await this.ensureFolderExists(folderPath);

			// 构建文件选择列表
			const selectionItems: FileSelectionItem[] = [];
			let skippedCount = 0;

			for (const page of pages) {
				// 检查同步规则
				if (!this.checkSyncRules(page.properties)) {
					skippedCount++;
					continue;
				}

				const filename = this.generateFilename(page);
				const filePath = normalizePath(`${folderPath}/${filename}.md`);
				const existingFile = this.app.vault.getAbstractFileByPath(filePath);

				selectionItems.push({
					page,
					filename,
					filePath,
					exists: existingFile instanceof TFile,
					selected: true, // 默认全选
					overwrite: true, // 默认覆盖
				});
			}

			if (selectionItems.length === 0) {
				new Notice('没有满足同步规则的文件');
				return;
			}

			// 显示文件选择弹窗
			new FileSyncSelectionModal(
				this.app,
				selectionItems,
				folderPath,
				(selectedItems) => this.executeSelectedSync(selectedItems, skippedCount)
			).open();

		} catch (error) {
			console.error('Sync error:', error);
			new Notice(`同步失败: ${error.message}`);
		}
	}

	// 执行用户选择的同步
	async executeSelectedSync(selectedItems: FileSelectionItem[], skippedCount: number): Promise<void> {
		const result: SyncResult = {
			created: [],
			updated: [],
			unchanged: 0,
			skipped: skippedCount,
		};

		try {
			for (const item of selectedItems) {
				const content = await this.generateFileContent(item.page);

				if (item.exists) {
					if (item.overwrite) {
						// 覆盖已存在的文件
						const existingFile = this.app.vault.getAbstractFileByPath(item.filePath);
						if (existingFile instanceof TFile) {
							const oldContent = await this.app.vault.read(existingFile);
							await this.app.vault.modify(existingFile, content);
							result.updated.push({
								filename: item.filename,
								oldContent,
								newContent: content,
							});
						}
					} else {
						// 不覆盖，跳过
						result.unchanged++;
					}
				} else {
					// 创建新文件
					await this.app.vault.create(item.filePath, content);
					result.created.push(item.filename);
				}
			}

			// 显示结果
			new Notice(
				`同步完成！新增: ${result.created.length}, 更新: ${result.updated.length}, ` +
				`未变更: ${result.unchanged}, 跳过: ${result.skipped}`
			);

			// 显示详细结果
			new SyncResultModal(this.app, result).open();

		} catch (error) {
			console.error('Sync error:', error);
			new Notice(`同步失败: ${error.message}`);
		}
	}

	// 确保文件夹存在
	async ensureFolderExists(path: string): Promise<void> {
		const adapter = this.app.vault.adapter;
		if (!(await adapter.exists(path))) {
			await adapter.mkdir(path);
		}
	}
}

// ==================== 差异对比弹窗 ====================

class DiffModal extends Modal {
	filename: string;
	oldContent: string;
	newContent: string;

	constructor(app: App, filename: string, oldContent: string, newContent: string) {
		super(app);
		this.filename = filename;
		this.oldContent = oldContent;
		this.newContent = newContent;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl('h2', { text: `文件对比: ${this.filename}` });

		// 说明
		const desc = contentEl.createEl('p', {
			text: '红色为删除的内容，绿色为新增的内容',
			cls: 'setting-item-description',
		});
		desc.style.marginBottom = '15px';

		// 对比容器
		const diffContainer = contentEl.createDiv();
		diffContainer.style.maxHeight = '400px';
		diffContainer.style.overflow = 'auto';
		diffContainer.style.border = '1px solid var(--background-modifier-border)';
		diffContainer.style.borderRadius = '4px';
		diffContainer.style.fontFamily = 'monospace';
		diffContainer.style.fontSize = '12px';
		diffContainer.style.lineHeight = '1.5';

		// 计算差异
		const diff = this.computeDiff(this.oldContent, this.newContent);

		// 渲染差异
		diff.forEach(part => {
			const line = diffContainer.createDiv();
			line.style.padding = '2px 8px';
			line.style.whiteSpace = 'pre-wrap';
			line.style.wordBreak = 'break-all';

			if (part.added) {
				line.style.backgroundColor = 'rgba(0, 255, 0, 0.1)';
				line.style.color = '#2ea043';
				line.textContent = `+ ${part.value}`;
			} else if (part.removed) {
				line.style.backgroundColor = 'rgba(255, 0, 0, 0.1)';
				line.style.color = '#f85149';
				line.textContent = `- ${part.value}`;
			} else {
				line.style.color = 'var(--text-muted)';
				line.textContent = `  ${part.value}`;
			}
		});

		// 按钮区域
		const buttonContainer = contentEl.createDiv();
		buttonContainer.style.marginTop = '20px';
		buttonContainer.style.display = 'flex';
		buttonContainer.style.gap = '10px';

		// 查看文件按钮
		const viewBtn = buttonContainer.createEl('button', { text: '在笔记中查看' });
		viewBtn.addEventListener('click', () => {
			const folderPath = normalizePath(
				(this.app as any).plugins.plugins['notion-database-sync']?.settings?.syncFolder || 'Notion Sync'
			);
			const filePath = normalizePath(`${folderPath}/${this.filename}.md`);
			const file = this.app.vault.getAbstractFileByPath(filePath);
			if (file instanceof TFile) {
				this.app.workspace.openLinkText(filePath, '');
				this.close();
			}
		});

		// 关闭按钮
		const closeBtn = buttonContainer.createEl('button', { text: '关闭', cls: 'mod-cta' });
		closeBtn.addEventListener('click', () => {
			this.close();
		});
	}

	// 简单的行级差异计算
	computeDiff(oldText: string, newText: string): { value: string; added?: boolean; removed?: boolean }[] {
		const oldLines = oldText.split('\n');
		const newLines = newText.split('\n');
		const result: { value: string; added?: boolean; removed?: boolean }[] = [];

		let i = 0, j = 0;
		while (i < oldLines.length || j < newLines.length) {
			if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
				// 相同的行
				result.push({ value: oldLines[i] });
				i++;
				j++;
			} else if (j < newLines.length && (i >= oldLines.length || !oldLines.slice(i).includes(newLines[j]))) {
				// 新增的行
				result.push({ value: newLines[j], added: true });
				j++;
			} else if (i < oldLines.length) {
				// 删除的行
				result.push({ value: oldLines[i], removed: true });
				i++;
			} else {
				// 剩余的新增行
				result.push({ value: newLines[j], added: true });
				j++;
			}
		}

		return result;
	}

	onClose() {
		this.contentEl.empty();
	}
}

// ==================== 文件选择弹窗 ====================

class FileSyncSelectionModal extends Modal {
	items: FileSelectionItem[];
	onConfirm: (selectedItems: FileSelectionItem[]) => void;
	folderPath: string;

	constructor(app: App, items: FileSelectionItem[], folderPath: string, onConfirm: (selectedItems: FileSelectionItem[]) => void) {
		super(app);
		this.items = items;
		this.folderPath = folderPath;
		this.onConfirm = onConfirm;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();

		this.setTitle('选择要同步的文件');

		// 说明文字
		const descDiv = contentEl.createDiv();
		descDiv.style.marginBottom = '16px';
		descDiv.createEl('p', { text: `共找到 ${this.items.length} 个满足同步规则的文件，请选择要同步的文件：` });

		// 全选/取消全选按钮
		const selectAllDiv = contentEl.createDiv();
		selectAllDiv.style.marginBottom = '12px';
		selectAllDiv.style.display = 'flex';
		selectAllDiv.style.gap = '8px';

		const selectAllBtn = selectAllDiv.createEl('button', { text: '全选' });
		selectAllBtn.addEventListener('click', () => {
			this.items.forEach(item => item.selected = true);
			this.renderFileList(contentEl);
		});

		const deselectAllBtn = selectAllDiv.createEl('button', { text: '取消全选' });
		deselectAllBtn.addEventListener('click', () => {
			this.items.forEach(item => item.selected = false);
			this.renderFileList(contentEl);
		});

		// 文件列表容器
		this.renderFileList(contentEl);

		// 底部按钮
		const buttonDiv = contentEl.createDiv();
		buttonDiv.style.marginTop = '20px';
		buttonDiv.style.display = 'flex';
		buttonDiv.style.gap = '12px';
		buttonDiv.style.justifyContent = 'flex-end';

		const cancelBtn = buttonDiv.createEl('button', { text: '取消' });
		cancelBtn.addEventListener('click', () => {
			this.close();
		});

		const confirmBtn = buttonDiv.createEl('button', { text: '开始同步', cls: 'mod-cta' });
		confirmBtn.addEventListener('click', () => {
			const selectedItems = this.items.filter(item => item.selected);
			if (selectedItems.length === 0) {
				new Notice('请至少选择一个文件进行同步');
				return;
			}
			this.close();
			this.onConfirm(selectedItems);
		});
	}

	renderFileList(contentEl: HTMLElement) {
		// 移除旧列表
		const oldList = contentEl.querySelector('.file-selection-list');
		if (oldList) {
			oldList.remove();
		}

		const listContainer = contentEl.createDiv('file-selection-list');
		listContainer.style.maxHeight = '400px';
		listContainer.style.overflowY = 'auto';
		listContainer.style.border = '1px solid var(--background-modifier-border)';
		listContainer.style.borderRadius = '4px';

		this.items.forEach((item, index) => {
			const row = listContainer.createDiv('file-selection-item');
			row.style.display = 'flex';
			row.style.alignItems = 'center';
			row.style.padding = '8px 12px';
			row.style.borderBottom = '1px solid var(--background-modifier-border)';
			row.style.gap = '12px';

			// 复选框
			const checkbox = row.createEl('input', { type: 'checkbox' });
			checkbox.checked = item.selected;
			checkbox.addEventListener('change', (e) => {
				this.items[index].selected = (e.target as HTMLInputElement).checked;
			});

			// 文件名
			const nameSpan = row.createSpan({ text: item.filename });
			nameSpan.style.flex = '1';

			// 状态标签
			if (item.exists) {
				const existsTag = row.createSpan({ text: '已存在' });
				existsTag.style.fontSize = '12px';
				existsTag.style.padding = '2px 8px';
				existsTag.style.borderRadius = '4px';
				existsTag.style.backgroundColor = 'var(--text-accent)';
				existsTag.style.color = 'var(--text-on-accent)';

				// 覆盖选项
				const overwriteLabel = row.createEl('label');
				overwriteLabel.style.display = 'flex';
				overwriteLabel.style.alignItems = 'center';
				overwriteLabel.style.gap = '4px';
				overwriteLabel.style.fontSize = '12px';

				const overwriteCheckbox = overwriteLabel.createEl('input', { type: 'checkbox' });
				overwriteCheckbox.checked = item.overwrite;
				overwriteCheckbox.addEventListener('change', (e) => {
					this.items[index].overwrite = (e.target as HTMLInputElement).checked;
				});

				overwriteLabel.createSpan({ text: '覆盖' });
			} else {
				const newTag = row.createSpan({ text: '新建' });
				newTag.style.fontSize = '12px';
				newTag.style.padding = '2px 8px';
				newTag.style.borderRadius = '4px';
				newTag.style.backgroundColor = 'var(--interactive-success)';
				newTag.style.color = 'var(--text-on-accent)';
			}
		});
	}

	onClose() {
		this.contentEl.empty();
	}
}

// ==================== 同步结果弹窗 ====================

class SyncResultModal extends Modal {
	result: SyncResult;

	constructor(app: App, result: SyncResult) {
		super(app);
		this.result = result;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl('h2', { text: '同步结果' });

		// 统计信息
		const statsDiv = contentEl.createDiv();
		statsDiv.style.marginBottom = '20px';
		statsDiv.createEl('p', { text: `✅ 新增: ${this.result.created.length} 个文件` });
		statsDiv.createEl('p', { text: `📝 更新: ${this.result.updated.length} 个文件` });
		statsDiv.createEl('p', { text: `⏭️ 未变更: ${this.result.unchanged} 个文件` });
		statsDiv.createEl('p', { text: `⏭️ 跳过: ${this.result.skipped} 个文件` });

		// 新增文件列表
		if (this.result.created.length > 0) {
			contentEl.createEl('h3', { text: '📄 新增文件' });
			const createdList = contentEl.createEl('ul');
			this.result.created.forEach(filename => {
				const li = createdList.createEl('li');
				li.style.display = 'flex';
				li.style.alignItems = 'center';
				li.style.gap = '10px';

				li.createSpan({ text: filename });

				// 查看按钮
				const viewBtn = li.createEl('button', { text: '查看' });
				viewBtn.style.fontSize = '12px';
				viewBtn.style.padding = '2px 8px';
				viewBtn.addEventListener('click', () => {
					const folderPath = normalizePath(
						(this.app as any).plugins.plugins['notion-database-sync']?.settings?.syncFolder || 'Notion Sync'
					);
					const filePath = normalizePath(`${folderPath}/${filename}.md`);
					const file = this.app.vault.getAbstractFileByPath(filePath);
					if (file instanceof TFile) {
						this.app.workspace.openLinkText(filePath, '');
						this.close();
					}
				});
			});
		}

		// 更新文件列表
		if (this.result.updated.length > 0) {
			contentEl.createEl('h3', { text: '🔄 更新文件' });
			const updatedList = contentEl.createEl('ul');
			this.result.updated.forEach(({ filename, oldContent, newContent }) => {
				const li = updatedList.createEl('li');
				li.style.display = 'flex';
				li.style.alignItems = 'center';
				li.style.gap = '10px';

				li.createSpan({ text: filename });

				// 对比按钮
				const diffBtn = li.createEl('button', { text: '对比' });
				diffBtn.style.fontSize = '12px';
				diffBtn.style.padding = '2px 8px';
				diffBtn.addEventListener('click', () => {
					new DiffModal(this.app, filename, oldContent, newContent).open();
				});

				// 查看按钮
				const viewBtn = li.createEl('button', { text: '查看' });
				viewBtn.style.fontSize = '12px';
				viewBtn.style.padding = '2px 8px';
				viewBtn.addEventListener('click', () => {
					const folderPath = normalizePath(
						(this.app as any).plugins.plugins['notion-database-sync']?.settings?.syncFolder || 'Notion Sync'
					);
					const filePath = normalizePath(`${folderPath}/${filename}.md`);
					const file = this.app.vault.getAbstractFileByPath(filePath);
					if (file instanceof TFile) {
						this.app.workspace.openLinkText(filePath, '');
						this.close();
					}
				});
			});
		}

		// 关闭按钮
		const closeBtn = contentEl.createEl('button', { text: '关闭', cls: 'mod-cta' });
		closeBtn.style.marginTop = '20px';
		closeBtn.addEventListener('click', () => {
			this.close();
		});
	}

	onClose() {
		this.contentEl.empty();
	}
}

// 模板文件选择模态框
class TemplateFileSuggestModal extends Modal {
	onSelect: (file: TFile) => void;

	constructor(app: App, onSelect: (file: TFile) => void) {
		super(app);
		this.onSelect = onSelect;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		this.setTitle('选择模板文件');

		// 获取所有 markdown 文件
		const files = this.app.vault.getMarkdownFiles();

		// 创建文件列表
		const listEl = contentEl.createDiv('template-file-list');
		listEl.style.maxHeight = '400px';
		listEl.style.overflow = 'auto';

		if (files.length === 0) {
			listEl.createEl('p', { text: '没有找到 Markdown 文件' });
			return;
		}

		// 按路径排序
		files.sort((a, b) => a.path.localeCompare(b.path));

		files.forEach((file) => {
			const itemEl = listEl.createDiv('template-file-item');
			itemEl.style.padding = '8px 12px';
			itemEl.style.cursor = 'pointer';
			itemEl.style.borderRadius = '4px';
			itemEl.style.marginBottom = '4px';

			// 鼠标悬停效果
			itemEl.addEventListener('mouseenter', () => {
				itemEl.style.backgroundColor = 'var(--background-modifier-hover)';
			});
			itemEl.addEventListener('mouseleave', () => {
				itemEl.style.backgroundColor = '';
			});

			// 文件名和路径
			const nameEl = itemEl.createDiv('template-file-name');
			nameEl.style.fontWeight = '500';
			nameEl.textContent = file.name;

			const pathEl = itemEl.createDiv('template-file-path');
			pathEl.style.fontSize = '0.85em';
			pathEl.style.color = 'var(--text-muted)';
			pathEl.textContent = file.path;

			// 点击选择
			itemEl.addEventListener('click', () => {
				this.onSelect(file);
				this.close();
			});
		});

		// 添加搜索框
		const searchContainer = contentEl.createDiv('search-container');
		searchContainer.style.marginBottom = '12px';
		const searchInput = searchContainer.createEl('input', {
			type: 'text',
			placeholder: '搜索文件...',
		});
		searchInput.style.width = '100%';
		searchInput.style.padding = '8px';

		searchInput.addEventListener('input', (e) => {
			const query = (e.target as HTMLInputElement).value.toLowerCase();
			const items = listEl.querySelectorAll('.template-file-item');
			items.forEach((item) => {
				const path = item.querySelector('.template-file-path')?.textContent || '';
				const name = item.querySelector('.template-file-name')?.textContent || '';
				if (path.toLowerCase().includes(query) || name.toLowerCase().includes(query)) {
					(item as HTMLElement).style.display = 'block';
				} else {
					(item as HTMLElement).style.display = 'none';
				}
			});
		});

		// 将搜索框插入到列表之前
		contentEl.insertBefore(searchContainer, listEl);
	}

	onClose() {
		this.contentEl.empty();
	}
}

// ==================== 设置页面 ====================

class NotionSyncSettingTab extends PluginSettingTab {
	plugin: NotionSyncPlugin;
	propertyMappingsContainer: HTMLElement;
	syncRulesContainer: HTMLElement;

	constructor(app: App, plugin: NotionSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl('h2', { text: 'Notion Database Sync 设置' });

		// 基础配置
		containerEl.createEl('h3', { text: '基础配置' });

		new Setting(containerEl)
			.setName('Notion Token')
			.setDesc('你的 Notion Integration Token')
			.addText((text) =>
				text
					.setPlaceholder('secret_xxx')
					.setValue(this.plugin.settings.notionToken)
					.onChange(async (value) => {
						this.plugin.settings.notionToken = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('Database ID')
			.setDesc('要同步的 Notion 数据库 ID')
			.addText((text) =>
				text
					.setPlaceholder('xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx')
					.setValue(this.plugin.settings.databaseId)
					.onChange(async (value) => {
						this.plugin.settings.databaseId = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('同步文件夹')
			.setDesc('同步文件保存的文件夹路径')
			.addText((text) =>
				text
					.setPlaceholder('Notion Sync')
					.setValue(this.plugin.settings.syncFolder)
					.onChange(async (value) => {
						this.plugin.settings.syncFolder = value.trim() || 'Notion Sync';
						await this.plugin.saveSettings();
					})
			);

		// 测试连接
		new Setting(containerEl)
			.setName('测试连接')
			.setDesc('测试与 Notion API 的连接')
			.addButton((button) =>
				button
					.setButtonText('测试连接')
					.onClick(async () => {
						await this.testConnection();
					})
			);

		// 文件名配置
		containerEl.createEl('h3', { text: '文件名配置' });

		new Setting(containerEl)
			.setName('文件名属性')
			.setDesc('使用哪个 Notion 属性作为文件名（默认为标题）')
			.addText((text) =>
				text
					.setPlaceholder('title')
					.setValue(this.plugin.settings.filenameProperty)
					.onChange(async (value) => {
						this.plugin.settings.filenameProperty = value.trim() || 'title';
						await this.plugin.saveSettings();
					})
			);

		// 属性映射配置
		containerEl.createEl('h3', { text: '属性映射配置' });

		containerEl.createEl('p', {
			text: '点击"刷新属性"获取 Notion 数据库的属性列表',
		});

		new Setting(containerEl)
			.setName('获取数据库属性')
			.setDesc('从 Notion 数据库获取最新的属性列表')
			.addButton((button) =>
				button
					.setButtonText('刷新属性')
					.onClick(async () => {
						await this.refreshProperties();
					})
			);

		this.propertyMappingsContainer = containerEl.createDiv('property-mappings-container');
		this.renderPropertyMappings();

		// 同步规则配置
		containerEl.createEl('h3', { text: '同步规则配置' });

		containerEl.createEl('p', {
			text: '配置同步判定规则，只有满足所有规则的记录才会被同步',
		});

		new Setting(containerEl)
			.setName('添加同步规则')
			.setDesc('添加一条新的同步判定规则')
			.addButton((button) =>
				button
					.setButtonText('添加规则')
					.onClick(async () => {
						this.plugin.settings.syncRules.push({
							property: '',
							condition: 'notEmpty',
						});
						await this.plugin.saveSettings();
						this.renderSyncRules();
					})
			);

		this.syncRulesContainer = containerEl.createDiv('sync-rules-container');
		this.renderSyncRules();

		// 文件模板配置
		containerEl.createEl('h3', { text: '文件模板配置' });

		// 模板文件选择
		const templateFileSetting = new Setting(containerEl)
			.setName('模板文件')
			.setDesc('选择本地仓库中的文件作为模板（可选）。如果设置了模板文件，将优先使用文件内容而不是下方文本框中的模板。')
			.addText((text) => {
				text
					.setPlaceholder('未选择文件')
					.setValue(this.plugin.settings.templateFilePath)
					.onChange(async (value) => {
						this.plugin.settings.templateFilePath = value;
						await this.plugin.saveSettings();
					});
				text.inputEl.style.width = '250px';
			})
			.addButton((button) => {
				button
					.setButtonText('选择文件')
					.onClick(() => {
						new TemplateFileSuggestModal(this.app, (file) => {
							this.plugin.settings.templateFilePath = file.path;
							this.plugin.saveSettings();
							// 更新文本框显示
							templateFileSetting.controlEl.querySelector('input')!.value = file.path;
						}).open();
					});
			})
			.addButton((button) => {
				button
					.setButtonText('清除')
					.onClick(async () => {
						this.plugin.settings.templateFilePath = '';
						await this.plugin.saveSettings();
						templateFileSetting.controlEl.querySelector('input')!.value = '';
					});
			});

		new Setting(containerEl)
			.setName('默认文件模板')
			.setDesc('使用 {{变量名}} 作为模板变量，{{frontmatter}} 表示所有启用的属性，{{title}} 表示标题，{{content}} 表示内容占位符。当未设置模板文件时使用此模板。')
			.addTextArea((text) => {
				text
					.setPlaceholder('---\n{{frontmatter}}\n---\n\n# {{title}}\n\n{{content}}')
					.setValue(this.plugin.settings.fileTemplate)
					.onChange(async (value) => {
						this.plugin.settings.fileTemplate = value;
						await this.plugin.saveSettings();
					});
				text.inputEl.rows = 6;
				text.inputEl.style.width = '100%';
			});
	}

	async refreshProperties(): Promise<void> {
		const properties = await this.plugin.fetchDatabaseProperties();
		if (!properties) {
			new Notice('获取属性失败，请检查 Token 和 Database ID');
			return;
		}

		const existingMappings = new Map(
			this.plugin.settings.propertyMappings.map(m => [m.notionProperty, m])
		);

		this.plugin.settings.propertyMappings = Object.entries(properties).map(([name, prop]: [string, any]) => {
			const existing = existingMappings.get(name);
			return {
				notionProperty: name,
				notionType: prop.type,
				obsidianProperty: existing?.obsidianProperty || name.toLowerCase().replace(/\s+/g, '_'),
				enabled: existing?.enabled ?? true,
				isTemplateVariable: existing?.isTemplateVariable ?? true,
			};
		});

		await this.plugin.saveSettings();
		this.renderPropertyMappings();
		new Notice(`已获取 ${Object.keys(properties).length} 个属性`);
	}

	renderPropertyMappings(): void {
		this.propertyMappingsContainer.empty();

		if (this.plugin.settings.propertyMappings.length === 0) {
			this.propertyMappingsContainer.createEl('p', {
				text: '暂无属性映射，请先点击"刷新属性"获取数据库属性',
				cls: 'setting-item-description',
			});
			return;
		}

		const headerRow = this.propertyMappingsContainer.createDiv('property-mapping-header');
		headerRow.style.display = 'grid';
		headerRow.style.gridTemplateColumns = '2fr 1.5fr 80px 100px 60px';
		headerRow.style.gap = '8px';
		headerRow.style.padding = '8px';
		headerRow.style.fontWeight = 'bold';
		headerRow.style.borderBottom = '1px solid var(--background-modifier-border)';

		headerRow.createSpan({ text: 'Notion 属性' });
		headerRow.createSpan({ text: 'Obsidian 属性' });
		headerRow.createSpan({ text: '类型' });
		headerRow.createSpan({ text: '同步' });
		headerRow.createSpan({ text: '模板' });

		this.plugin.settings.propertyMappings.forEach((mapping, index) => {
			const row = this.propertyMappingsContainer.createDiv('property-mapping-row');
			row.style.display = 'grid';
			row.style.gridTemplateColumns = '2fr 1.5fr 80px 100px 60px';
			row.style.gap = '8px';
			row.style.padding = '8px';
			row.style.borderBottom = '1px solid var(--background-modifier-border)';
			row.style.alignItems = 'center';

			row.createSpan({ text: mapping.notionProperty });

			const obsidianInput = row.createEl('input', {
				type: 'text',
				value: mapping.obsidianProperty,
			});
			obsidianInput.style.width = '100%';
			obsidianInput.addEventListener('change', async (e) => {
				this.plugin.settings.propertyMappings[index].obsidianProperty = (e.target as HTMLInputElement).value;
				await this.plugin.saveSettings();
			});

			row.createSpan({ 
				text: mapping.notionType,
				cls: 'setting-item-description',
			});

			const enabledContainer = row.createDiv();
			enabledContainer.style.display = 'flex';
			enabledContainer.style.alignItems = 'center';
			const enabledToggle = enabledContainer.createEl('input', {
				type: 'checkbox',
			});
			enabledToggle.checked = mapping.enabled;
			enabledToggle.addEventListener('change', async (e) => {
				this.plugin.settings.propertyMappings[index].enabled = (e.target as HTMLInputElement).checked;
				await this.plugin.saveSettings();
			});

			const templateContainer = row.createDiv();
			templateContainer.style.display = 'flex';
			templateContainer.style.alignItems = 'center';
			const templateToggle = templateContainer.createEl('input', {
				type: 'checkbox',
			});
			templateToggle.checked = mapping.isTemplateVariable;
			templateToggle.addEventListener('change', async (e) => {
				this.plugin.settings.propertyMappings[index].isTemplateVariable = (e.target as HTMLInputElement).checked;
				await this.plugin.saveSettings();
			});
		});

		const desc = this.propertyMappingsContainer.createEl('p', {
			text: '同步：是否在 Obsidian 中同步此属性 | 模板：是否可在文件模板中作为变量使用',
			cls: 'setting-item-description',
		});
		desc.style.marginTop = '8px';
		desc.style.fontSize = '12px';
	}

	renderSyncRules(): void {
		this.syncRulesContainer.empty();

		if (this.plugin.settings.syncRules.length === 0) {
			this.syncRulesContainer.createEl('p', {
				text: '暂无同步规则，所有记录都会被同步',
				cls: 'setting-item-description',
			});
			return;
		}

		const availableProperties = this.plugin.settings.propertyMappings.map(m => m.notionProperty);

		this.plugin.settings.syncRules.forEach((rule, index) => {
			const row = this.syncRulesContainer.createDiv('sync-rule-row');
			row.style.display = 'flex';
			row.style.gap = '8px';
			row.style.padding = '8px';
			row.style.borderBottom = '1px solid var(--background-modifier-border)';
			row.style.alignItems = 'center';
			row.style.flexWrap = 'wrap';

			const propertySelect = row.createEl('select');
			propertySelect.style.width = '150px';
			propertySelect.add(new Option('选择属性', ''));
			availableProperties.forEach(prop => {
				propertySelect.add(new Option(prop, prop));
			});
			propertySelect.value = rule.property;
			propertySelect.addEventListener('change', async (e) => {
				this.plugin.settings.syncRules[index].property = (e.target as HTMLSelectElement).value;
				await this.plugin.saveSettings();
			});

			const conditionSelect = row.createEl('select');
			conditionSelect.style.width = '120px';
			const conditions: { value: SyncRule['condition']; label: string }[] = [
				{ value: 'equals', label: '等于' },
				{ value: 'notEmpty', label: '不为空' },
				{ value: 'isTrue', label: '为真' },
				{ value: 'isFalse', label: '为假' },
			];
			conditions.forEach(c => {
				conditionSelect.add(new Option(c.label, c.value));
			});
			conditionSelect.value = rule.condition;
			conditionSelect.addEventListener('change', async (e) => {
				this.plugin.settings.syncRules[index].condition = (e.target as HTMLSelectElement).value as SyncRule['condition'];
				await this.plugin.saveSettings();
				this.renderSyncRules();
			});

			if (rule.condition === 'equals') {
				const valueInput = row.createEl('input', {
					type: 'text',
					value: rule.value || '',
					placeholder: '输入值',
				});
				valueInput.style.width = '120px';
				valueInput.addEventListener('change', async (e) => {
					this.plugin.settings.syncRules[index].value = (e.target as HTMLInputElement).value;
					await this.plugin.saveSettings();
				});
			}

			const deleteBtn = row.createEl('button', {
				text: '删除',
			});
			deleteBtn.addEventListener('click', async () => {
				this.plugin.settings.syncRules.splice(index, 1);
				await this.plugin.saveSettings();
				this.renderSyncRules();
			});
		});

		const desc = this.syncRulesContainer.createEl('p', {
			text: '只有满足所有规则的记录才会被同步到 Obsidian',
			cls: 'setting-item-description',
		});
		desc.style.marginTop = '8px';
		desc.style.fontSize = '12px';
	}

	async testConnection(): Promise<void> {
		if (!this.plugin.notionClient) {
			new Notice('请先配置 Notion Token');
			return;
		}

		if (!this.plugin.settings.databaseId) {
			new Notice('请先配置 Database ID');
			return;
		}

		try {
			const response = await this.plugin.notionClient.databases.retrieve(this.plugin.settings.databaseId);
			const dbTitle = response.title?.[0]?.plain_text ?? '未命名';
			new Notice(`连接成功！数据库标题: ${dbTitle}`);
		} catch (error) {
			console.error('Connection test error:', error);
			new Notice(`连接失败: ${error.message}`);
		}
	}
}

