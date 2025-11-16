// Frontend logic: fetch Apex HTML via /proxy, parse, compute ratings, update UI.

const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const apexInput = document.getElementById('apexUrl');
const statusEl = document.getElementById('status');
const rankTbody = document.querySelector('#rankTable tbody');
const pitLog = document.getElementById('pitLog');
const autoDetect = document.getElementById('autoDetect');

let pollInterval = 4000; // ms
let pollTimer = null;
let lastHtml = '';

// in-memory storage
const transponderLaps = {}; // id -> array of lap objects {lapNumber, time, sectors, timestamp}
const teamProfiles = {}; // teamName -> {baseline, count}

// simple utility: parse Apex HTML to extract lap rows
function parseApexHtml(html){
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const rows = [];

  const table = doc.querySelector('.live-lap-table') || doc.querySelector('#lapsTable') || doc.querySelector('table');
  if (!table) return rows;
  const trs = table.querySelectorAll('tr');
  trs.forEach(tr=>{
    const cols = Array.from(tr.querySelectorAll('td')).map(td=>td.textContent.trim());
    if (cols.length < 2) return;
    const text = cols.join(' | ');
    const timeMatch = text.match(/(\d{1,2}:\d{2}\.\d{2})|(\d+\.\d{2})/);
    const lapTime = timeMatch ? timeMatch[0] : null;
    const numberMatch = text.match(/\b\d{1,3}\b/);
    const number = numberMatch ? numberMatch[0] : null;
    if (lapTime && number){
      rows.push({number, lapTime, raw:cols});
    }
  });
  return rows;
}

function parseSeconds(t){
  if (!t) return null;
  if (t.includes(':')){
    const [m,s] = t.split(':');
    return parseInt(m)*60 + parseFloat(s);
  }
  return parseFloat(t);
}

function updateProfiles(){
  Object.keys(transponderLaps).forEach(tid=>{
    const laps = transponderLaps[tid];
    if (!laps || laps.length < 2) return;
    const avg = laps.slice(-10).map(x=>x.time).reduce((a,b)=>a+b,0)/Math.max(1,laps.slice(-10).length);
    const team = laps.length>0 && laps[0].team ? laps[0].team : 'team_'+tid;
    if (!teamProfiles[team]) teamProfiles[team] = {baseline:avg,count:1};
    else {
      const pf = teamProfiles[team];
      pf.count += 1;
      pf.baseline = (pf.baseline*(pf.count-1) + avg)/pf.count;
    }
  });
}

function computeScores(){
  const scores = [];
  Object.keys(transponderLaps).forEach(tid=>{
    const laps = transponderLaps[tid];
    if (!laps || laps.length<2) return;
    const lastN = laps.slice(-8);
    const avg = lastN.map(x=>x.time).reduce((a,b)=>a+b,0)/lastN.length;
    const best = Math.min(...lastN.map(x=>x.time));
    const std = Math.sqrt(lastN.map(x=>Math.pow(x.time-avg,2)).reduce((a,b)=>a+b,0)/lastN.length);
    const team = laps[0].team || ('team_'+tid);
    const baseline = teamProfiles[team] ? teamProfiles[team].baseline : avg;
    let delta = baseline - avg; 
    let score = 500 + delta*200 - std*50 + (baseline - best)*30;
    let conf = Math.min(0.99, Math.log(1 + laps.length)/Math.log(1+50));
    scores.push({tid, avg, best, std, score, conf, stint: laps[laps.length-1].stint || 0});
  });
  scores.sort((a,b)=>b.score - a.score);
  return scores;
}

function renderScores(scores){
  rankTbody.innerHTML = '';
  scores.forEach(s=>{
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${s.tid}</td><td>${s.score.toFixed(1)}</td><td>${(s.conf*100).toFixed(0)}%</td><td>${s.avg.toFixed(2)}</td><td>${s.best.toFixed(2)}</td><td>${s.stint}</td>`;
    tr.onclick = ()=>selectKart(s.tid);
    rankTbody.appendChild(tr);
  });
}

let selectedKart = null;
let chart = null;
function selectKart(tid){
  selectedKart = tid;
  const data = (transponderLaps[tid]||[]).map(x=>x.time);
  const labels = (transponderLaps[tid]||[]).map((x,i)=>i+1);
  if (!chart){
    const ctx = document.getElementById('trendChart').getContext('2d');
    chart = new Chart(ctx,{
      type:'line',
      data:{labels, datasets:[{label:tid, data, fill:false}]},
      options:{animation:false,scales:{y:{reverse:false}}}
    });
  } else {
    chart.data.labels = labels;
    chart.data.datasets[0].label = tid;
    chart.data.datasets[0].data = data;
    chart.update();
  }
}

function renderPitLog(){
  pitLog.innerHTML = '';
  const lines = [];
  Object.keys(transponderLaps).forEach(tid=>{
    const laps = transponderLaps[tid];
    if (!laps || laps.length===0) return;
    const last = laps[laps.length-1];
    if (last.pit) lines.push(`${tid} - pit at lap ${last.lapNumber} (stint ${last.stint})`);
  });
  lines.sort();
  lines.forEach(l=>{
    const li = document.createElement('li'); li.textContent = l; pitLog.appendChild(li);
  });
}

async function pollApex(url){
  try{
    statusEl.textContent = 'Fetching...';
    const resp = await fetch('/proxy?url='+encodeURIComponent(url));
    if (!resp.ok) throw new Error('fetch failed');
    const html = await resp.text();
    if (html === lastHtml){
      statusEl.textContent = 'No change';
      return;
    }
    lastHtml = html;
    const rows = parseApexHtml(html);
    rows.forEach(r=>{
      const time = parseSeconds(r.lapTime);
      if (!time) return;
      const tid = r.number;
      if (!transponderLaps[tid]) transponderLaps[tid] = [];
      const prev = transponderLaps[tid].slice(-1)[0];
      const lapNumber = prev ? (prev.lapNumber+1) : 1;
      const pit = false;
      const stint = prev ? prev.stint : 1;
      transponderLaps[tid].push({lapNumber, time, pit, stint, team:'team_'+tid, timestamp:Date.now()});

      if (prev && time - prev.time > 20 && autoDetect.checked){
        transponderLaps[tid][transponderLaps[tid].length-1].pit = true;
        transponderLaps[tid][transponderLaps[tid].length-1].stint = prev.stint + 1;
      }
    });

    updateProfiles();
    const scores = computeScores();
    renderScores(scores);
    renderPitLog();
    if (selectedKart && transponderLaps[selectedKart]) selectKart(selectedKart);
    statusEl.textContent = `Updated ${new Date().toLocaleTimeString()}`;
  }catch(err){
    console.error(err);
    statusEl.textContent = 'Error fetching Apex page';
  }
}

startBtn.onclick = ()=>{
  const url = apexInput.value.trim();
  if (!url){ alert('Paste Apex Timing URL first'); return; }
  startBtn.disabled = true; stopBtn.disabled = false; apexInput.disabled = true;
  pollTimer = setInterval(()=>pollApex(url), pollInterval);
  pollApex(url);
}
stopBtn.onclick = ()=>{
  clearInterval(pollTimer); pollTimer = null; startBtn.disabled=false; stopBtn.disabled=true; apexInput.disabled=false; statusEl.textContent='Stopped';
}
