# Kit v2 : demarre l'assistant (droits administrateur) qui bloque l'horloge NVIDIA pendant la mesure.
#   sans argument : drapeau tmp\nvlock.running, assistant lance en RunAs, attente de LOCK ou ECHEC dans tmp\nvlock.log
#   -WaitReset    : attend RESET (le lanceur a deja retire le drapeau)
param([switch]$WaitReset)
$kit = Split-Path -Parent $PSScriptRoot
$flag = Join-Path $kit 'tmp\nvlock.running'
$log = Join-Path $kit 'tmp\nvlock.log'
function WaitFor($pattern, $seconds) {
  for ($i = 0; $i -lt $seconds * 2; $i++) {
    if (Test-Path -LiteralPath $log) { $hit = Select-String -LiteralPath $log -Pattern $pattern | Select-Object -Last 1; if ($hit) { return $hit.Line } }
    Start-Sleep -Milliseconds 500
  }
  return $null
}
if ($WaitReset) {
  $l = WaitFor '^RESET' 30
  if ($l) { Write-Host $l; exit 0 }
  Write-Host '[ATTENTION] horloge NVIDIA peut-etre encore bloquee : en administrateur, nvidia-smi -rgc puis nvidia-smi -rmc'
  exit 1
}
Remove-Item -LiteralPath $log -ErrorAction SilentlyContinue
Set-Content -LiteralPath $flag -Value '' -Encoding ascii
$helper = Join-Path $PSScriptRoot 'nv-clock-lock.ps1'
$q = [char]34
try { Start-Process powershell -Verb RunAs -WindowStyle Hidden -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ($q + $helper + $q), '-Flag', ($q + $flag + $q), '-Log', ($q + $log + $q)) | Out-Null }
catch { Remove-Item -LiteralPath $flag -ErrorAction SilentlyContinue; Write-Host 'autorisation administrateur refusee'; exit 2 }
$l = WaitFor '^(LOCK|ECHEC)' 30
if ($l -and $l.StartsWith('LOCK')) { Write-Host $l; exit 0 }
Remove-Item -LiteralPath $flag -ErrorAction SilentlyContinue
if ($l) { Write-Host $l } else { Write-Host 'assistant NVIDIA sans reponse (30 s)' }
exit 3
