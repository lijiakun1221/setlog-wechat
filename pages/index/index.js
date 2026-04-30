const api = require("../../utils/api");

const MAX_SECONDS = 2;
const MAX_RECORD_MS = MAX_SECONDS * 1000;

function getTimeZone() {
  return getApp().globalData.timeZone || "Europe/Rome";
}

function nowIso() {
  return new Date().toISOString();
}

function pad(num) {
  return String(num).padStart(2, "0");
}

function formatClock(date = new Date()) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: getTimeZone(),
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);
}

function formatDateKey(date = new Date()) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: getTimeZone()
  }).format(date);
}

function formatDateTime(dateString) {
  if (!dateString) {
    return "";
  }
  return new Date(dateString).toLocaleString("zh-CN", {
    timeZone: getTimeZone(),
    hour12: false
  });
}

function formatDuration(ms) {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `00:${pad(Math.min(seconds, 59))}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requestCameraPermission() {
  return new Promise((resolve, reject) => {
    wx.getSetting({
      success(settingResult) {
        if (settingResult.authSetting["scope.camera"]) {
          resolve();
          return;
        }
        wx.authorize({
          scope: "scope.camera",
          success: resolve,
          fail() {
            wx.showModal({
              title: "需要相机权限",
              content: "请在系统设置中允许相机权限，才能开始拍摄。",
              confirmText: "去设置",
              success(modalResult) {
                if (modalResult.confirm) {
                  wx.openSetting({
                    success(openResult) {
                      if (openResult.authSetting["scope.camera"]) {
                        resolve();
                        return;
                      }
                      reject(new Error("未开启相机权限"));
                    },
                    fail(err) {
                      reject(err);
                    }
                  });
                  return;
                }
                reject(new Error("未开启相机权限"));
              }
            });
          }
        });
      },
      fail(err) {
        reject(err);
      }
    });
  });
}

function requestAlbumPermission() {
  return new Promise((resolve, reject) => {
    wx.getSetting({
      success(settingResult) {
        if (settingResult.authSetting["scope.writePhotosAlbum"]) {
          resolve();
          return;
        }
        wx.authorize({
          scope: "scope.writePhotosAlbum",
          success: resolve,
          fail() {
            wx.showModal({
              title: "需要相册权限",
              content: "保存视频到本地需要开启相册权限。",
              confirmText: "去设置",
              success(modalResult) {
                if (modalResult.confirm) {
                  wx.openSetting({
                    success(openResult) {
                      if (openResult.authSetting["scope.writePhotosAlbum"]) {
                        resolve();
                        return;
                      }
                      reject(new Error("未开启相册权限"));
                    },
                    fail(err) {
                      reject(err);
                    }
                  });
                  return;
                }
                reject(new Error("未开启相册权限"));
              }
            });
          }
        });
      },
      fail(err) {
        reject(err);
      }
    });
  });
}

function compressVideoIfPossible(src) {
  if (typeof wx.compressVideo !== "function") {
    return Promise.resolve(src);
  }

  return new Promise((resolve) => {
    wx.compressVideo({
      src,
      quality: "medium",
      success(result) {
        resolve(result.tempFilePath || result.filePath || src);
      },
      fail() {
        resolve(src);
      }
    });
  });
}

function showToast(title) {
  wx.showToast({
    title,
    icon: "none",
    duration: 1800
  });
}

async function loginWithWechat() {
  return new Promise((resolve, reject) => {
    wx.login({
      success: async (loginResult) => {
        if (!loginResult.code) {
          reject(new Error("没有拿到微信登录 code"));
          return;
        }
        try {
          const nickname = `用户${loginResult.code.slice(-4)}`;
          const auth = await api.request("/api/auth/wechat-login", "POST", {
            code: loginResult.code,
            nickname
          });
          resolve(auth);
        } catch (error) {
          reject(error);
        }
      },
      fail(err) {
        reject(err);
      }
    });
  });
}

Page({
  data: {
    activeTab: "camera",
    clockLabel: "16:00",
    flashMode: "off",
    devicePosition: "back",
    recording: false,
    recordingProgress: 0,
    recordingLabel: "00:00",
    cameraReady: false,
    cameraError: "",
    capturePressed: false,
    statusText: "",
    clips: [],
    users: [],
    logs: [],
    currentUserName: "",
    currentLogName: "",
    pendingVideoPath: "",
    pendingRecordedAt: "",
    pendingClipDuration: MAX_SECONDS,
    actionSheetBusy: false
  },

  onLoad() {
    this.maxRecordMs = MAX_RECORD_MS;
    this.clockTimer = null;
    this.progressTimer = null;
    this.autoStopTimer = null;
    this.stopRecordInFlight = false;
    this.cameraContext = null;
    this.pendingUploadInfo = null;
    this.currentUser = null;
    this.currentLog = null;

    this.startClock();
    this.bootstrap().catch((error) => {
      this.setData({ statusText: `初始化失败：${error.message}` });
    });
    this.ensureLogin().catch(() => {
      // 登录失败时继续使用本地/匿名状态，不阻断拍摄页。
    });
  },

  onReady() {
    this.cameraContext = wx.createCameraContext();
    this.setData({ cameraReady: true });
  },

  onHide() {
    this.clearTimers();
  },

  onUnload() {
    this.clearTimers();
  },

  clearTimers() {
    if (this.clockTimer) {
      clearInterval(this.clockTimer);
      this.clockTimer = null;
    }
    if (this.progressTimer) {
      clearInterval(this.progressTimer);
      this.progressTimer = null;
    }
    if (this.autoStopTimer) {
      clearTimeout(this.autoStopTimer);
      this.autoStopTimer = null;
    }
  },

  startClock() {
    const tick = () => {
      this.setData({ clockLabel: formatClock(new Date()) });
    };
    tick();
    this.clockTimer = setInterval(tick, 30000);
  },

  async ensureLogin() {
    try {
      const auth = await loginWithWechat();
      const app = getApp();
      app.globalData.sessionId = auth.sessionId;
      app.globalData.currentUserId = auth.userId;
      app.globalData.currentUser = auth.user;
      this.currentUser = auth.user || null;
      this.setData({
        currentUserName: auth.user ? auth.user.name : "",
        statusText: auth.user ? `已登录 ${auth.user.name}` : "已登录"
      });
    } catch (error) {
      this.setData({
        statusText: `未完成微信登录，继续使用匿名模式：${error.message}`
      });
    }
  },

  async bootstrap() {
    wx.showLoading({ title: "加载中", mask: true });
    try {
      const payload = await api.request("/api/bootstrap");
      const users = Array.isArray(payload.users) ? payload.users : [];
      const logs = Array.isArray(payload.logs) ? payload.logs : [];
      const clips = Array.isArray(payload.clips) ? payload.clips : [];

      const annotatedClips = clips
        .map((clip) => ({
          ...clip,
          userName: this.lookupUserName(users, clip.userId),
          logName: this.lookupLogName(logs, clip.logId),
          recordedLocal: formatDateTime(clip.recordedAt),
          dateLabel: clip.dateKey || formatDateKey(clip.recordedAt || new Date())
        }))
        .sort((a, b) => new Date(b.recordedAt).getTime() - new Date(a.recordedAt).getTime());

      const currentUserId = getApp().globalData.currentUserId || payload.currentUser?.id || users[0]?.id || "";
      const currentLogId = payload.logs?.[0]?.id || logs[0]?.id || "";
      this.currentUser = users.find((item) => item.id === currentUserId) || payload.currentUser || users[0] || null;
      this.currentLog = logs.find((item) => item.id === currentLogId) || logs[0] || null;

      this.setData(
        {
          users,
          logs,
          clips: annotatedClips,
          currentUserName: this.currentUser ? this.currentUser.name : "",
          currentLogName: this.currentLog ? this.currentLog.name : "",
          statusText: `已加载 ${users.length} 位用户、${logs.length} 个 log、${annotatedClips.length} 条片段`
        },
        () => {
          this.syncDerivedLists();
        }
      );
    } catch (error) {
      this.setData({
        statusText: `加载失败：${error.message}`
      });
    } finally {
      wx.hideLoading();
    }
  },

  syncDerivedLists() {
    const todayKey = formatDateKey(new Date());
    const recentClips = this.data.clips.filter((clip) => clip.dateLabel === todayKey);
    this.setData({
      recentClips,
      todayClipCount: recentClips.length
    });
  },

  lookupUserName(users, userId) {
    const user = users.find((item) => item.id === userId);
    return user ? user.name : userId || "";
  },

  lookupLogName(logs, logId) {
    const log = logs.find((item) => item.id === logId);
    return log ? log.name : logId || "";
  },

  getCurrentUser() {
    if (this.currentUser) {
      return this.currentUser;
    }
    return this.data.users[0] || null;
  },

  getCurrentLog() {
    if (this.currentLog) {
      return this.currentLog;
    }
    return this.data.logs[0] || null;
  },

  switchTab(event) {
    const tab = event.currentTarget.dataset.tab;
    if (!tab || tab === this.data.activeTab) {
      return;
    }
    this.setData({ activeTab: tab });
  },

  toggleFlash() {
    this.setData({
      flashMode: this.data.flashMode === "on" ? "off" : "on"
    });
  },

  flipCamera() {
    this.setData({
      devicePosition: this.data.devicePosition === "back" ? "front" : "back"
    });
  },

  tapClose() {
    if (this.data.recording) {
      this.stopRecording();
      return;
    }
    this.setData({ activeTab: "logs" });
  },

  async startRecording() {
    if (this.data.recording || this.stopRecordInFlight) {
      return;
    }
    if (!this.cameraContext) {
      showToast("相机还没有准备好");
      return;
    }

    try {
      await requestCameraPermission();
    } catch (error) {
      this.setData({
        cameraError: error.message,
        statusText: error.message
      });
      return;
    }

    this.captureStartedAt = new Date();
    const startedAtIso = nowIso();
    this.pendingRecordedAt = startedAtIso;

    this.setData({
      cameraError: "",
      recording: true,
      recordingProgress: 0,
      recordingLabel: "00:00",
      capturePressed: true,
      statusText: "正在录制 2 秒视频"
    });

    setTimeout(() => {
      this.setData({ capturePressed: false });
    }, 180);

    this.progressTimer = setInterval(() => {
      const elapsed = Date.now() - this.captureStartedAt.getTime();
      const progress = Math.min(elapsed / this.maxRecordMs, 1);
      this.setData({
        recordingProgress: progress * 100,
        recordingLabel: formatDuration(elapsed)
      });
    }, 80);

    this.autoStopTimer = setTimeout(() => {
      this.stopRecording();
    }, this.maxRecordMs);

    try {
      this.cameraContext.startRecord({
        success: () => {
          this.pendingRecordedAt = startedAtIso;
        },
        fail: (error) => {
          this.finishRecordingState();
          this.setData({
            statusText: `开始录制失败：${error.errMsg || error.message || "未知错误"}`
          });
        }
      });
    } catch (error) {
      this.finishRecordingState();
      this.setData({
        statusText: `开始录制失败：${error.message}`
      });
    }
  },

  stopRecording() {
    if (!this.data.recording || this.stopRecordInFlight || !this.cameraContext) {
      return;
    }

    this.stopRecordInFlight = true;
    if (this.autoStopTimer) {
      clearTimeout(this.autoStopTimer);
      this.autoStopTimer = null;
    }

    try {
      this.cameraContext.stopRecord({
        success: async (result) => {
          this.stopRecordInFlight = false;
          await this.handleRecordedVideo(result.tempVideoPath);
        },
        fail: (error) => {
          this.stopRecordInFlight = false;
          this.finishRecordingState();
          this.setData({
            statusText: `停止录制失败：${error.errMsg || error.message || "未知错误"}`
          });
        }
      });
    } catch (error) {
      this.stopRecordInFlight = false;
      this.finishRecordingState();
      this.setData({
        statusText: `停止录制失败：${error.message}`
      });
    }
  },

  finishRecordingState() {
    if (this.progressTimer) {
      clearInterval(this.progressTimer);
      this.progressTimer = null;
    }
    if (this.autoStopTimer) {
      clearTimeout(this.autoStopTimer);
      this.autoStopTimer = null;
    }
    this.setData({
      recording: false,
      capturePressed: false,
      recordingProgress: 0,
      recordingLabel: "00:00"
    });
  },

  async handleRecordedVideo(tempVideoPath) {
    this.finishRecordingState();
    if (!tempVideoPath) {
      this.setData({ statusText: "没有拿到视频临时路径" });
      return;
    }

    try {
      const processedPath = await compressVideoIfPossible(tempVideoPath);
      this.pendingUploadInfo = {
        originalPath: tempVideoPath,
        processedPath,
        recordedAt: this.pendingRecordedAt || nowIso(),
        durationSeconds: MAX_SECONDS
      };
      this.setData({
        pendingVideoPath: processedPath,
        statusText: "录制完成，等待下一步操作"
      });
      await sleep(80);
      this.presentActionSheet();
    } catch (error) {
      this.setData({
        pendingVideoPath: tempVideoPath,
        statusText: `视频处理失败：${error.message}`
      });
      await sleep(80);
      this.presentActionSheet();
    }
  },

  presentActionSheet() {
    if (this.data.actionSheetBusy || !this.pendingUploadInfo) {
      return;
    }
    this.setData({ actionSheetBusy: true });

    wx.showActionSheet({
      itemList: ["上传", "保存到本地", "分享给朋友群"],
      success: async (result) => {
        try {
          if (result.tapIndex === 0) {
            await this.uploadPendingVideo();
          } else if (result.tapIndex === 1) {
            await this.savePendingVideo();
          } else if (result.tapIndex === 2) {
            await this.sharePendingVideo();
          }
        } finally {
          this.setData({ actionSheetBusy: false });
        }
      },
      fail: () => {
        this.setData({ actionSheetBusy: false });
      }
    });
  },

  async uploadPendingVideo() {
    const user = this.getCurrentUser();
    const log = this.getCurrentLog();
    const filePath = this.pendingUploadInfo?.processedPath || this.data.pendingVideoPath;
    if (!user || !log) {
      showToast("没有可用的用户或 log");
      return;
    }
    if (!filePath) {
      showToast("没有可上传的视频");
      return;
    }

    wx.showLoading({ title: "上传中", mask: true });
    try {
      const intent = await api.request("/api/upload-intents", "POST", {
        userId: user.id,
        logId: log.id,
        recordedAt: this.pendingUploadInfo?.recordedAt || nowIso(),
        durationSeconds: MAX_SECONDS,
        note: "",
        timeZone: getTimeZone()
      });

      await api.uploadFile(intent.uploadUrl, filePath);
      this.setData({
        statusText: "视频已上传"
      });
      showToast("上传成功");
      await this.bootstrap();
    } catch (error) {
      this.setData({
        statusText: `上传失败：${error.message}`
      });
      showToast("上传失败");
    } finally {
      wx.hideLoading();
    }
  },

  async savePendingVideo() {
    const filePath = this.pendingUploadInfo?.processedPath || this.data.pendingVideoPath;
    if (!filePath) {
      showToast("没有可保存的视频");
      return;
    }

    try {
      await requestAlbumPermission();
      await new Promise((resolve, reject) => {
        wx.saveVideoToPhotosAlbum({
          filePath,
          success: resolve,
          fail: reject
        });
      });
      this.setData({ statusText: "已保存到本地相册" });
      showToast("已保存到本地");
    } catch (error) {
      this.setData({
        statusText: `保存失败：${error.message}`
      });
      showToast("保存失败");
    }
  },

  async sharePendingVideo() {
    const filePath = this.pendingUploadInfo?.processedPath || this.data.pendingVideoPath;
    if (!filePath) {
      showToast("没有可分享的视频");
      return;
    }

    if (typeof wx.shareVideoMessage !== "function") {
      wx.showModal({
        title: "当前基础库不支持",
        content: "你的微信版本暂不支持视频分享接口，可以先保存到本地。",
        showCancel: false
      });
      return;
    }

    try {
      await new Promise((resolve, reject) => {
        wx.shareVideoMessage({
          filePath,
          title: "SetLog 片段",
          success: resolve,
          fail: reject
        });
      });
      this.setData({ statusText: "已打开分享面板" });
      showToast("已打开分享");
    } catch (error) {
      this.setData({
        statusText: `分享失败：${error.message}`
      });
      showToast("分享失败");
    }
  },

  onCameraError(event) {
    const message = event.detail?.errMsg || "相机加载失败";
    this.setData({
      cameraError: message,
      statusText: message
    });
  },

  retryPermission() {
    this.setData({ cameraError: "" });
    requestCameraPermission().catch((error) => {
      this.setData({ cameraError: error.message });
    });
  }
});
