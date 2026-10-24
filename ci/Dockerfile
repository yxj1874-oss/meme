# Reference substrate (design D2-A): linux/arm64 + Mesa lavapipe (software Vulkan) + dawn.node.
# Goldens are only byte-comparable inside this image; its digest is part of substrate_id.
FROM node:24.22.0-trixie-slim@sha256:a6155384446670e9719bdc4fd0ebe4d4b29fb32a8d6aa523da3547a6cfbcf22c

# Debian packages come from a fixed snapshot so a rebuild resolves the same Mesa/LLVM bytes.
ARG SNAPSHOT=20261020T000000Z
RUN rm -f /etc/apt/sources.list.d/debian.sources \
 && printf '%s\n' \
      "deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/${SNAPSHOT} trixie main" \
      "deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/${SNAPSHOT} trixie-updates main" \
      "deb [check-valid-until=no] http://snapshot.debian.org/archive/debian-security/${SNAPSHOT} trixie-security main" \
      > /etc/apt/sources.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      mesa-vulkan-drivers=25.0.7-2+deb13u1 \
      libvulkan1=1.4.309.0-1 \
 && rm -rf /var/lib/apt/lists/*

# Only lavapipe is visible to the Vulkan loader, so Dawn cannot pick a different adapter.
ENV VK_ICD_FILENAMES=/usr/share/vulkan/icd.d/lvp_icd.json
WORKDIR /work
