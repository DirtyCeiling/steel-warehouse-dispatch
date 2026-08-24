# 钢厂库区调度系统 - GitHub上传脚本
# 使用说明:
# 1. 确保已安装Git
# 2. 双击运行此脚本，或在PowerShell中执行: .\upload-to-github.ps1

param(
    [Parameter(Mandatory=$false)]
    [string]$GitHubUsername = "",
    
    [Parameter(Mandatory=$false)]
    [string]$RepoName = "steel-warehouse-dispatch"
)

# 设置Git路径
$GitPath = "C:\Program Files\Git\bin\git.exe"
$GitCmd = "C:\Program Files\Git\cmd\git.exe"

# 检查Git是否安装
function Test-GitInstalled {
    $gitCmd = Get-Command git -ErrorAction SilentlyContinue
    if ($gitCmd) {
        return $true
    }
    
    # 检查常见安装路径
    $paths = @(
        "C:\Program Files\Git\bin\git.exe",
        "C:\Program Files\Git\cmd\git.exe",
        "C:\Program Files (x86)\Git\bin\git.exe",
        "C:\Git\bin\git.exe"
    )
    
    foreach ($path in $paths) {
        if (Test-Path $path) {
            $script:GIT_EXE = $path
            return $true
        }
    }
    
    return $false
}

# 如果没有提供用户名，询问用户
if ([string]::IsNullOrEmpty($GitHubUsername)) {
    Write-Host "请输入你的GitHub用户名:" -ForegroundColor Yellow
    $GitHubUsername = Read-Host
}

# 检查Git是否安装
Write-Host "检查Git安装..." -ForegroundColor Cyan
if (-not (Test-GitInstalled)) {
    Write-Host "错误: Git未安装。请先安装Git: https://git-scm.com/download/win" -ForegroundColor Red
    Write-Host "或者下载: https://github.com/git-for-windows/git/releases/latest" -ForegroundColor Yellow
    Read-Host "按Enter键退出"
    exit 1
}

Write-Host "Git已找到" -ForegroundColor Green

# 获取项目路径
$ProjectPath = Split-Path -Parent $MyInvocation.MyCommand.Path

# 切换到项目目录
Set-Location $ProjectPath

# 检查是否已是Git仓库
if (Test-Path ".git") {
    Write-Host "已是Git仓库" -ForegroundColor Cyan
} else {
    Write-Host "初始化Git仓库..." -ForegroundColor Cyan
    & git init
    
    # 配置Git用户（如果没有配置）
    $gitUser = & git config user.name
    if ([string]::IsNullOrEmpty($gitUser)) {
        Write-Host "请设置Git用户信息:" -ForegroundColor Yellow
        Write-Host "git config --global user.name `"你的名字`""
        Write-Host "git config --global user.email `"你的邮箱`""
    }
}

# 添加所有文件
Write-Host "添加文件到暂存区..." -ForegroundColor Cyan
& git add .

# 提交
Write-Host "提交更改..." -ForegroundColor Cyan
& git commit -m "Initial commit: 钢厂库区调度系统

- 三维库区可视化
- 库存管理
- 调度任务
- 数据分析"

# 检查是否有远程仓库
$remoteUrl = & git remote get-url origin 2>$null

if ([string]::IsNullOrEmpty($remoteUrl)) {
    Write-Host "`n创建GitHub仓库并推送..." -ForegroundColor Cyan
    Write-Host "`n请在GitHub上创建仓库，然后运行以下命令:" -ForegroundColor Yellow
    Write-Host "git remote add origin https://github.com/$GitHubUsername/$RepoName.git" -ForegroundColor Green
    Write-Host "git branch -M main" -ForegroundColor Green
    Write-Host "git push -u origin main" -ForegroundColor Green
    Write-Host "`n或者直接使用GitHub CLI:" -ForegroundColor Yellow
    Write-Host "gh repo create $RepoName --public --push" -ForegroundColor Green
} else {
    Write-Host "`n推送到远程仓库..." -ForegroundColor Cyan
    & git remote add origin "https://github.com/$GitHubUsername/$RepoName.git" 2>$null
    & git branch -M main
    & git push -u origin main
}

Write-Host "`n完成!" -ForegroundColor Green
Write-Host "项目已上传到: https://github.com/$GitHubUsername/$RepoName" -ForegroundColor Cyan

Read-Host "按Enter键退出"
