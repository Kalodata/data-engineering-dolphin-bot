#!/usr/bin/env bash
# Read-only Hive/Spark SQL via JDBC (DataGrip driver jar).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DIR="$(cd "$(dirname "$0")" && pwd)"
JAR="${HIVE_JDBC_JAR:-}"
if [[ -z "$JAR" ]]; then
  for cand in \
    "$HOME/Library/Application Support/JetBrains/DataGrip2026.1/jdbc-drivers/Apache Spark/3.1.2/hive-jdbc-3.1.2-standalone.jar" \
    "$HOME/Library/Application Support/JetBrains/DataGrip2025.3/jdbc-drivers/Apache Spark/3.1.2/hive-jdbc-3.1.2-standalone.jar"
  do
    if [[ -f "$cand" ]]; then JAR="$cand"; break; fi
  done
fi
if [[ -z "${JAR}" || ! -f "$JAR" ]]; then
  echo "hive-ro: HIVE_JDBC_JAR not found" >&2
  exit 3
fi
if [[ ! -f "$DIR/HiveRo.class" ]]; then
  javac -cp "$JAR" "$DIR/HiveRo.java"
fi
export HIVE_JDBC_URL="${HIVE_JDBC_URL:-jdbc:hive2://localhost:10001}"
exec java -cp "$DIR:$JAR" HiveRo "$@"
