# Notion Database Sync

将 Notion 数据库记录同步到 Obsidian 笔记的插件。

## 功能特性

### ✅ 1. 基础配置
- 支持配置 Notion Token 和 Database ID
- 支持测试连接验证配置

### ✅ 2. 属性映射
- 自动获取 Notion 数据库属性列表
- 支持 Notion 属性与 Obsidian 属性名称映射
- 可单独选择是否同步每个属性
- 支持将属性作为模板变量使用

### ✅ 3. 同步规则
- 支持添加多条同步判定规则
- 支持条件：等于、不为空、为真、为假
- 只有满足所有规则的记录才会被同步

### ✅ 4. 同步文件夹
- 可指定同步文件保存的文件夹路径
- 自动创建不存在的文件夹

### ✅ 5. 同步命令
- 命令面板中可唤起同步操作
- 快捷键支持

### ✅ 6. 增量同步
- 自动判断新增和更新的记录
- 只同步有变化的文件
- 跳过未变更的记录以提高效率

### ✅ 7. 同步结果展示
- 同步完成后显示统计信息
- 分类展示：新增文件、更新文件、未变更、跳过
- 每个文件可直接点击查看

### ✅ 8. 对比功能
- 更新文件支持查看对比
- 显示新增（绿色）和删除（红色）的内容
- 行级差异对比

## 支持的 Notion 属性类型

- title (标题)
- rich_text (富文本)
- number (数字)
- select (单选)
- multi_select (多选)
- checkbox (复选框)
- url (链接)
- email (邮箱)
- phone_number (电话)
- date (日期)
- status (状态)
- formula (公式)
- rollup (汇总)
- relation (关联)
- created_time (创建时间)
- last_edited_time (最后编辑时间)
- created_by (创建者)
- last_edited_by (最后编辑者)

## 安装方法

1. 确保已安装 Node.js (v16+)
2. 在项目目录运行 `npm install`
3. 运行 `npm run build` 编译插件
4. 将编译后的 `main.js`, `manifest.json`, `styles.css` 复制到 Obsidian 插件目录：
   - Windows: `%USERPROFILE%\Documents\Obsidian Vault\.obsidian\plugins\notion-database-sync\`
   - macOS: `~/Documents/Obsidian Vault/.obsidian/plugins/notion-database-sync/`
   - Linux: `~/Documents/Obsidian Vault/.obsidian/plugins/notion-database-sync/`
5. 在 Obsidian 设置中启用插件

## 使用方法

### 1. 配置插件
- 打开 Obsidian 设置
- 找到 "Notion Database Sync" 设置页面
- 填写 Notion Token 和 Database ID
- 点击"测试连接"验证配置

### 2. 配置属性映射
- 点击"刷新属性"获取数据库属性
- 自定义 Obsidian 属性名称
- 选择要同步的属性
- 选择可作为模板变量的属性

### 3. 配置同步规则（可选）
- 添加同步判定规则
- 例如：只同步 "状态" 为 "已完成" 的记录

### 4. 执行同步
- 打开命令面板（Ctrl/Cmd + P）
- 输入 "Sync Notion Database"
- 或使用设置的快捷键

### 5. 查看结果
- 同步完成后会显示结果弹窗
- 可查看新增和更新的文件列表
- 更新文件可点击查看对比

## 文件模板

支持使用以下变量：
- `{{frontmatter}}` - 所有启用的属性（YAML格式）
- `{{title}}` - 页面标题
- `{{content}}` - 内容占位符
- `{{属性名}}` - 自定义属性值

默认模板：
```markdown
---
{{frontmatter}}
---

# {{title}}

{{content}}
```

## 开发

```bash
# 安装依赖
npm install

# 开发模式（自动编译）
npm run dev

# 生产构建
npm run build
```

## 许可证

MIT License
