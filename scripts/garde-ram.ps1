# Kit portable : chemins relatifs au kit (<kit>/tmp/nuit.running, <kit>/tmp/garde-ram.log), profils <kit>/tmp/bench-profiles.
$kitTmp = Join-Path (Split-Path -Parent $PSScriptRoot) 'tmp'
# Garde-fou RAM de la nuit : sous 3 Go libres, tue les Chrome du banc (profil dans <kit>/tmp/bench-profiles), et eux seuls.
while (Test-Path "$kitTmp/nuit.running") {
  $free = (Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1MB
  if ($free -lt 3) {
    $procs = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -match 'bench-profiles' })
    # Conversion .frag (web-ifc dans node) d'une grosse maquette : même sort.
    $procs += @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'to-frag|--form frag' })
    # view.mjs reste bloqué sans son Chrome : arrêté aussi, la chaîne passe à la mesure suivante (échec noté).
    $procs += @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'scripts/view.mjs' })
    foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
    "{0:HH:mm:ss} RAM libre {1:N1} Go : {2} processus Chrome du banc tués" -f (Get-Date), $free, @($procs).Count | Out-File -Append -Encoding utf8 "$kitTmp/garde-ram.log"
    Start-Sleep -Seconds 10
  }
  Start-Sleep -Seconds 1
}

