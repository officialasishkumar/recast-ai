{{/* Common labels */}}
{{- define "recast.labels" -}}
helm.sh/chart: {{ include "recast.chart" . }}
{{ include "recast.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: recast-ai
{{- end }}

{{- define "recast.selectorLabels" -}}
app.kubernetes.io/name: {{ .Release.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "recast.serviceLabels" -}}
{{ include "recast.labels" . }}
app.kubernetes.io/component: {{ .component }}
{{- end }}

{{- define "recast.serviceSelector" -}}
{{ include "recast.selectorLabels" . }}
app.kubernetes.io/component: {{ .component }}
{{- end }}

{{- define "recast.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end }}

{{- define "recast.image" -}}
{{- $reg := .global.imageRegistry -}}
{{- $repo := .global.imageRepository -}}
{{- $tag := .global.imageTag | default .Chart.AppVersion -}}
{{- printf "%s/%s-%s:%s" $reg $repo .image $tag -}}
{{- end }}
