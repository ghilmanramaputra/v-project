# Shows one Windows notification. Called by check.mjs; -Data is base64 of a UTF-8 JSON
# object { title, message, url, image }. Keep this file ASCII (PowerShell 5.1 misreads BOM-less UTF-8).
param([string]$Data)

$j = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Data)) | ConvertFrom-Json
$null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
$null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
$AppId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'

$e = { param($s) [Security.SecurityElement]::Escape([string]$s) }
$img = ''
if ($j.image) { $img = '<image placement="appLogoOverride" src="' + (& $e $j.image) + '"/>' }
$launch = ''
$actions = '<action content="Tutup" activationType="system" arguments="dismiss"/>'
if ($j.url) {
    $launch = 'activationType="protocol" launch="' + (& $e $j.url) + '"'
    $actions = '<action content="Buka listing" activationType="protocol" arguments="' + (& $e $j.url) + '"/>' + $actions
}
$xml = @"
<toast $launch scenario="reminder">
  <visual><binding template="ToastGeneric">
    <text>$(& $e $j.title)</text>
    <text>$(& $e $j.message)</text>
    $img
  </binding></visual>
  <actions>$actions</actions>
  <audio src="ms-winsoundevent:Notification.Default"/>
</toast>
"@
$doc = New-Object Windows.Data.Xml.Dom.XmlDocument
$doc.LoadXml($xml)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($AppId).Show((New-Object Windows.UI.Notifications.ToastNotification $doc))
