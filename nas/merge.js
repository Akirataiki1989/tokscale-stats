const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO_DIR = '/volume1/docker/Tokscale/repo/tokscale-stats';
const OUTPUT_PATH = '/volume1/docker/Tokscale/tokscale/packages/frontend/public/my-data.json';

try {
  // 1. 同步最新分支
  process.chdir(REPO_DIR);
  console.log('Fetching all remote branches from GitHub...');
  execSync('git fetch --all --prune');

  // 2. 獲取所有電腦的分支
  const branchesOutput = execSync('git branch -r --list "origin/stats/*"', { encoding: 'utf8' });
  const branches = branchesOutput.split('\n')
    .map(b => b.trim())
    .filter(b => b.length > 0);

  console.log('Found computer stats branches:', branches);

  let mergedContributions = {};
  let allClients = new Set();
  let allModels = new Set();
  let totalTokens = 0;
  let totalCost = 0;
  let activeDaysSet = new Set();

  // 3. 讀取並合併各分支的資料
  for (const branch of branches) {
    const machine = branch.replace('origin/stats/', ''); // 提取電腦名稱
    
    try {
      console.log(`Reading data from branch: ${branch} (Machine: ${machine})`);
      const jsonContent = execSync(`git show ${branch}:my-data.json`, { encoding: 'utf8' });
      const data = JSON.parse(jsonContent);

      if (data && data.contributions) {
        if (data.summary) {
          if (data.summary.clients) data.summary.clients.forEach(c => allClients.add(c));
          if (data.summary.models) data.summary.models.forEach(m => allModels.add(m));
        }

        data.contributions.forEach(day => {
          const date = day.date;
          if ((day.totals?.tokens || 0) > 0) {
            activeDaysSet.add(date);
          }

          if (!mergedContributions[date]) {
            // 初始化該日期
            mergedContributions[date] = {
              date: date,
              totals: { tokens: 0, cost: 0, messages: 0 },
              intensity: 0,
              tokenBreakdown: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
              clients: [],
              activeTimeMs: 0
            };
          }

          // 累加 totals
          mergedContributions[date].totals.tokens += (day.totals.tokens || 0);
          mergedContributions[date].totals.cost += (day.totals.cost || 0);
          mergedContributions[date].totals.messages += (day.totals.messages || 0);

          // 累加 tokenBreakdown
          if (day.tokenBreakdown) {
            const tb = mergedContributions[date].tokenBreakdown;
            tb.input += (day.tokenBreakdown.input || 0);
            tb.output += (day.tokenBreakdown.output || 0);
            tb.cacheRead += (day.tokenBreakdown.cacheRead || 0);
            tb.cacheWrite += (day.tokenBreakdown.cacheWrite || 0);
            tb.reasoning += (day.tokenBreakdown.reasoning || 0);
          }

          // 合併 clients 陣列並標記機器來源
          if (day.clients) {
            day.clients.forEach(clientInfo => {
              // 標記這筆 client 統計是來自哪台 machine
              const infoWithMachine = {
                ...clientInfo,
                machine: machine
              };

              // 在已合併的列表中，尋找同 Client、同 Model、同 Machine 的項目進行累加
              const targetClient = mergedContributions[date].clients.find(
                c => c.client === infoWithMachine.client && 
                     c.modelId === infoWithMachine.modelId && 
                     c.machine === infoWithMachine.machine
              );

              if (targetClient) {
                targetClient.tokens.input += (infoWithMachine.tokens.input || 0);
                targetClient.tokens.output += (infoWithMachine.tokens.output || 0);
                targetClient.tokens.cacheRead += (infoWithMachine.tokens.cacheRead || 0);
                targetClient.tokens.cacheWrite += (infoWithMachine.tokens.cacheWrite || 0);
                targetClient.tokens.reasoning += (infoWithMachine.tokens.reasoning || 0);
                targetClient.cost += (infoWithMachine.cost || 0);
                targetClient.messages += (infoWithMachine.messages || 0);
              } else {
                mergedContributions[date].clients.push(infoWithMachine);
              }
            });
          }

          // 累加 activeTimeMs
          mergedContributions[date].activeTimeMs += (day.activeTimeMs || 0);
        });
      }
    } catch (err) {
      console.error(`Failed to read from branch ${branch}, skipping. Error:`, err.message);
    }
  }

  // 整理排序後的貢獻列表
  const sortedContributions = Object.values(mergedContributions)
    .sort((a, b) => a.date.localeCompare(b.date));

  if (sortedContributions.length === 0) {
    throw new Error("沒有任何有效數據可以合併");
  }

  // 4. 重新計算 years 與 summary 資訊
  let mergedYears = {};
  sortedContributions.forEach(day => {
    const year = day.date.substring(0, 4);
    totalTokens += (day.totals.tokens || 0);
    totalCost += (day.totals.cost || 0);

    if (!mergedYears[year]) {
      mergedYears[year] = {
        year: year,
        totalTokens: 0,
        totalCost: 0,
        range: { start: day.date, end: day.date }
      };
    }
    mergedYears[year].totalTokens += (day.totals.tokens || 0);
    mergedYears[year].totalCost += (day.totals.cost || 0);
    mergedYears[year].range.end = day.date;
  });

  const finalResult = {
    meta: {
      generatedAt: new Date().toISOString(),
      version: "4.0.10",
      dateRange: {
        start: sortedContributions[0].date,
        end: sortedContributions[sortedContributions.length - 1].date
      }
    },
    summary: {
      totalTokens: totalTokens,
      totalCost: totalCost,
      totalDays: sortedContributions.length,
      activeDays: activeDaysSet.size,
      averagePerDay: totalTokens / sortedContributions.length,
      maxCostInSingleDay: Math.max(...sortedContributions.map(d => d.totals.cost)),
      clients: Array.from(allClients),
      models: Array.from(allModels)
    },
    years: Object.values(mergedYears).sort((a, b) => a.year.localeCompare(b.year)),
    contributions: sortedContributions
  };

  // 5. 寫入目標檔案
  const outputDir = path.dirname(OUTPUT_PATH);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(finalResult, null, 2));
  console.log(`Merged data successfully written to ${OUTPUT_PATH}`);

} catch (error) {
  console.error('An error occurred during merge execution:', error.message);
}
