# Kit v2 (administrateur) : bloque l'horloge NVIDIA tant que le drapeau existe, puis la remet par defaut.
param([string]$Flag, [string]$Log)
function Say($s) { Add-Content -LiteralPath $Log -Value $s -Encoding ascii }
try {
  $q = ((& nvidia-smi --query-gpu=clocks.max.graphics,clocks.max.memory --format=csv,noheader,nounits) | Select-Object -First 1) -split ','
  $maxGr = [int]$q[0].Trim(); $maxMem = [int]$q[1].Trim()
  $gr = [int]([math]::Floor($maxGr * 0.75 / 15) * 15)
  if ($env:KIT_NV_CLOCK) { $gr = [int]$env:KIT_NV_CLOCK }
  $o = & nvidia-smi -lgc "$gr,$gr" 2>&1
  if ($LASTEXITCODE -ne 0) { Say ('ECHEC nvidia-smi -lgc : ' + ($o -join ' ')); exit 1 }
  $null = & nvidia-smi -lmc "$maxMem,$maxMem" 2>&1
  if ($LASTEXITCODE -eq 0) { $mem = ", memoire $maxMem MHz" } else { $mem = ', memoire non bloquee' }
  Say ("LOCK horloge GPU $gr MHz (75 pour cent de $maxGr)" + $mem)
  $idle = 0
  while (Test-Path -LiteralPath $Flag) {
    Start-Sleep -Seconds 5
    $busy = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'rebench\.mjs' }).Count
    if ($busy) { $idle = 0 } else { $idle += 5 }
    if ($idle -ge 180) { Say 'chaine de mesure absente depuis 3 min : fin'; break }
  }
} finally {
  $null = & nvidia-smi -rgc 2>&1
  $null = & nvidia-smi -rmc 2>&1
  Say 'RESET horloge NVIDIA remise par defaut'
}
