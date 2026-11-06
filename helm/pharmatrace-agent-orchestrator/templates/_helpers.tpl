{{- define "pharmatrace-agent-orchestrator.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "pharmatrace-agent-orchestrator.fullname" -}}
{{- if .Values.fullnameOverride }}{{ .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}{{ else }}{{ include "pharmatrace-agent-orchestrator.name" . }}{{ end }}
{{- end }}

{{- define "pharmatrace-agent-orchestrator.labels" -}}
helm.sh/chart: {{ include "pharmatrace-agent-orchestrator.name" . }}-{{ .Chart.Version | replace "+" "_" }}
app.kubernetes.io/name: {{ include "pharmatrace-agent-orchestrator.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "pharmatrace-agent-orchestrator.selectorLabels" -}}
app.kubernetes.io/name: {{ include "pharmatrace-agent-orchestrator.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "pharmatrace-agent-orchestrator.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}{{ default (include "pharmatrace-agent-orchestrator.fullname" .) .Values.serviceAccount.name }}{{ else }}{{ default "default" .Values.serviceAccount.name }}{{ end }}
{{- end }}

