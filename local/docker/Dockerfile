# The toolchain for local/ scripts: Bun (pinned), git, gh (for pushes over https) and flock. No code is copied in. The repo is
# bind-mounted at its host path, so the container runs the same files you edit.
FROM oven/bun:1.3.0

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates gh git openssh-client util-linux \
  && rm -rf /var/lib/apt/lists/*

# The repo is owned by the host user, not by container root. Without this, git refuses to work in it.
RUN git config --system --add safe.directory '*'
