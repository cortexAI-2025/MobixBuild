# MobixBuild – Android SaaS build backend
# Base: Ubuntu 22.04  |  Java 17  |  Node 18  |  Android SDK API 34
FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive \
    JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 \
    ANDROID_HOME=/opt/android-sdk \
    ANDROID_SDK_ROOT=/opt/android-sdk \
    BUILDS_DIR=/builds \
    SCRIPTS_DIR=/scripts \
    PORT=3000

ENV PATH="${JAVA_HOME}/bin:${ANDROID_HOME}/cmdline-tools/latest/bin:${ANDROID_HOME}/platform-tools:${ANDROID_HOME}/build-tools/34.0.0:${PATH}"

# ─── System packages ──────────────────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
      openjdk-17-jdk-headless \
      git \
      unzip \
      zip \
      wget \
      curl \
      ca-certificates \
      gnupg \
    && rm -rf /var/lib/apt/lists/*

# ─── Gradle (fallback for projects that ship no gradle-wrapper.jar) ──────────
ARG GRADLE_VERSION=8.6
RUN wget -q "https://services.gradle.org/distributions/gradle-${GRADLE_VERSION}-bin.zip" -O /tmp/gradle.zip \
    && unzip -q /tmp/gradle.zip -d /opt \
    && ln -s "/opt/gradle-${GRADLE_VERSION}/bin/gradle" /usr/local/bin/gradle \
    && rm /tmp/gradle.zip

# ─── Node.js 18 ───────────────────────────────────────────────────────────────
RUN curl -fsSL https://deb.nodesource.com/setup_18.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# ─── Android SDK command-line tools ──────────────────────────────────────────
# Download URL: https://developer.android.com/studio#command-line-tools-only
ARG CMDLINE_TOOLS_VERSION=11076708
RUN mkdir -p "${ANDROID_HOME}/cmdline-tools" \
    && wget -q \
       "https://dl.google.com/android/repository/commandlinetools-linux-${CMDLINE_TOOLS_VERSION}_latest.zip" \
       -O /tmp/cmdline-tools.zip \
    && unzip -q /tmp/cmdline-tools.zip -d /tmp/ct \
    && mv /tmp/ct/cmdline-tools "${ANDROID_HOME}/cmdline-tools/latest" \
    && rm -rf /tmp/cmdline-tools.zip /tmp/ct

# ─── SDK components ───────────────────────────────────────────────────────────
RUN yes | sdkmanager --licenses > /dev/null 2>&1 || true \
    && sdkmanager \
         "platforms;android-34" \
         "build-tools;34.0.0" \
         "platform-tools"

# ─── App setup ────────────────────────────────────────────────────────────────
WORKDIR /app

COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev

COPY server/ ./
COPY scripts/ /scripts/
RUN chmod +x /scripts/build.sh

RUN mkdir -p /builds /tmp/mobixbuild-uploads

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s \
  CMD curl -f http://localhost:3000/health || exit 1

CMD ["node", "index.js"]
