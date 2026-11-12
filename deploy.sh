#!/usr/bin/env bash
# Deploy to the cluster with plain kubectl: ship the code as ConfigMaps, apply the manifests, restart the pod.
#
#   ./deploy.sh                    # current kubectl context
#   ./deploy.sh --context my-cluster   # any extra arguments are passed to every kubectl call
#
# Each ConfigMap holds every file in one source directory (ConfigMaps can't hold subdirectories), under a fixed
# name, so a deploy overwrites them in place. The pod is restarted every time, because mounted code only reloads
# with a new pod. k8s/*.local.yaml (gitignored: your ingress, say) is applied too, if present.
set -euo pipefail
cd "$(dirname "$0")"

kubectl_() { kubectl "$@" ${KUBECTL_ARGS[@]+"${KUBECTL_ARGS[@]}"}; } # (+ form: empty arrays are fine under set -u on bash 3.2)
KUBECTL_ARGS=("$@")
NS=default

configmap() { # name, source directory
  kubectl create configmap "$1" --namespace "$NS" --from-file="$2" --dry-run=client -o yaml | kubectl_ apply -f -
}

configmap garmin-dash-sync   sync
configmap garmin-dash-api    api
configmap garmin-dash-web    web
configmap garmin-dash-web-css web/css
configmap garmin-dash-web-js web/js

kubectl_ apply -f k8s/garmin-dash.yaml
for f in k8s/*.local.yaml; do
  if [ -e "$f" ]; then kubectl_ apply -f "$f"; fi
done
kubectl_ --namespace "$NS" rollout restart deploy/garmin-dash
kubectl_ --namespace "$NS" rollout status deploy/garmin-dash --timeout=5m
