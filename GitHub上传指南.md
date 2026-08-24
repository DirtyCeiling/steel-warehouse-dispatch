# GitHub 上传指南

## 快速开始（自动脚本）

### 方法1: 使用PowerShell脚本（推荐）

1. 等待Git安装完成（检查桌面或开始菜单）
2. 双击运行 `upload-to-github.ps1` 脚本
3. 按提示输入GitHub用户名即可

### 方法2: 手动命令

#### 步骤1: 配置Git（首次使用）

打开PowerShell或Git Bash，执行：

```bash
git config --global user.name "你的GitHub用户名"
git config --global user.email "你的邮箱@example.com"
```

#### 步骤2: 初始化仓库

```bash
# 进入项目目录
cd F:\Robot_Project

# 初始化Git仓库
git init

# 添加所有文件
git add .

# 提交
git commit -m "Initial commit: 钢厂库区调度系统

- 三维库区可视化
- 库存管理
- 调度任务
- 数据分析"
```

#### 步骤3: 创建GitHub仓库

1. 打开浏览器访问: https://github.com
2. 登录你的GitHub账号
3. 点击右上角 "+" → "New repository"
4. 填写仓库名称: `steel-warehouse-dispatch`
5. 点击 "Create repository"

#### 步骤4: 推送代码

在Git Bash或PowerShell中执行（替换 `YOUR_USERNAME` 为你的用户名）：

```bash
# 添加远程仓库
git remote add origin https://github.com/YOUR_USERNAME/steel-warehouse-dispatch.git

# 重命名分支为main
git branch -M main

# 推送代码
git push -u origin main
```

#### 步骤5: 验证上传

刷新GitHub页面，应该能看到你的代码了！

## 常见问题

### Q1: Git命令提示"git不是内部或外部命令"
**A**: Git还没安装完成。请等待Git安装完成，或者手动运行Git安装程序 `C:\git-installer.exe`

### Q2: 推送时提示"Authentication failed"
**A**: 需要配置GitHub访问令牌或SSH密钥。建议使用GitHub CLI或令牌认证。

### Q3: 想要更新代码怎么办？
**A**: 
```bash
git add .
git commit -m "你的更新说明"
git push
```

## 使用GitHub CLI（可选）

如果安装Git时也安装了GitHub CLI，可以使用：

```bash
# 创建仓库并推送
gh repo create steel-warehouse-dispatch --public --push

# 或使用现有仓库
gh repo create steel-warehouse-dispatch --public
gh repo clone YOUR_USERNAME/steel-warehouse-dispatch
cd steel-warehouse-dispatch
# 复制项目文件后
git push
```

## 公开还是私有？

创建仓库时可以选择：
- **Public（公开）**: 任何人可见，免费
- **Private（私有）**: 仅自己可见，需要付费订阅

根据需要选择即可。

## 访问项目

上传成功后，访问：
```
https://github.com/YOUR_USERNAME/steel-warehouse-dispatch
```
