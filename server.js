const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const app = express();
const PORT = process.env.PORT || 5000;

// ======= CORS 設定 =======
app.use(cors({
  origin: [
    'https://carparktest4frontend.vercel.app', // 換成你Vercel前端網址
    'http://localhost:3000' // 測試用
  ],
  credentials: true
}));
app.use(express.json());

// ======= 連接 MongoDB Atlas =======
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => {
  console.log('MongoDB 連接成功');
}).catch(err => {
  console.error('MongoDB 連接失敗:', err);
});

// 定義充電器移動時間（秒）
const CABLE_MOVING_TIME = 30; // 30秒

// ======= 數據模型定義 =======
const ParkingSpotSchema = new mongoose.Schema({
  spotId: { type: Number, required: true, unique: true },
  status: { 
    type: String, 
    enum: ['空置中', '充電中', '等待中', '結束'],
    default: '空置中'
  },
  startTime: { type: Date },
  chargingTime: { type: Number }, // 充電時間（分鐘）
  waitingTime: { type: Number },  // 等待時間（分鐘）
  userId: { type: String },       // 使用者ID
  moveStartTime: { type: Date }   // 充電器移動開始時間，但不改變車位狀態
});

const ParkingSpot = mongoose.model('ParkingSpot', ParkingSpotSchema);

const QueueSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  spotId: { type: Number, required: true },
  chargingTime: { type: Number, required: true },
  requestTime: { type: Date, default: Date.now }
});

const ChargingQueue = mongoose.model('ChargingQueue', QueueSchema);

// ======= 輔助函數 =======
// 格式化時間的輔助函數
function formatTime(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}分${secs}秒`;
}

// 初始化停車位
async function initParkingSpots() {
  try {
    const count = await ParkingSpot.countDocuments();
    if (count === 0) {
      // 初始化5個車位，編號為7-11
      const initialSpots = [];
      for (let i = 7; i <= 11; i++) {
        initialSpots.push({ spotId: i, status: '空置中' });
      }
      await ParkingSpot.insertMany(initialSpots);
      console.log('停車位初始化完成');
    }
  } catch (error) {
    console.error('初始化停車位失敗:', error);
  }
}

// 重置所有車位狀態
async function initializeAllSpots() {
  try {
    await ParkingSpot.updateMany(
      { status: { $ne: '空置中' } },
      { 
        $set: { 
          status: '空置中',
          startTime: null,
          chargingTime: null,
          waitingTime: null,
          userId: null,
          moveStartTime: null
        } 
      }
    );
    await ChargingQueue.deleteMany({});
    console.log('所有車位已重置為空置中');
  } catch (error) {
    console.error('重置車位狀態失敗:', error);
  }
}

// 確保車位編號為7-11
async function ensureCorrectSpotIds() {
  try {
    const spots = await ParkingSpot.find().sort({ spotId: 1 });
    
    // 檢查是否有足夠的車位
    if (spots.length < 5) {
      // 添加缺少的車位
      const missingSpots = [];
      for (let i = 7; i <= 11; i++) {
        if (!spots.some(s => s.spotId === i)) {
          missingSpots.push({ spotId: i, status: '空置中' });
        }
      }
      
      if (missingSpots.length > 0) {
        await ParkingSpot.insertMany(missingSpots);
        console.log(`添加了 ${missingSpots.length} 個車位`);
      }
    }
    
    // 檢查車位編號是否需要調整
    const spotsAfterInit = await ParkingSpot.find().sort({ _id: 1 });
    let updated = false;
    
    // 只保留5個車位，刪除多餘的車位
    if (spotsAfterInit.length > 5) {
      // 優先保留ID在7-11範圍內的車位
      const correctIdSpots = spotsAfterInit.filter(s => s.spotId >= 7 && s.spotId <= 11);
      
      // 如果正確ID的車位不足5個，添加其他車位
      let spotsToKeep = correctIdSpots.length >= 5 
        ? correctIdSpots.slice(0, 5) 
        : [...correctIdSpots, ...spotsAfterInit.filter(s => !(s.spotId >= 7 && s.spotId <= 11))].slice(0, 5);
      
      // 獲取要保留的車位ID
      const keepIds = spotsToKeep.map(s => s._id.toString());
      
      // 刪除不在保留列表中的車位
      await ParkingSpot.deleteMany({ _id: { $nin: keepIds } });
      console.log(`刪除了 ${spotsAfterInit.length - 5} 個多餘車位`);
      updated = true;
    }
    
    // 確保車位ID為7-11
    const finalSpots = await ParkingSpot.find().sort({ _id: 1 }).limit(5);
    const targetIds = [7, 8, 9, 10, 11];
    
    for (let i = 0; i < finalSpots.length; i++) {
      if (finalSpots[i].spotId !== targetIds[i]) {
        finalSpots[i].spotId = targetIds[i];
        await finalSpots[i].save();
        updated = true;
      }
    }
    
    if (updated) {
      console.log('車位編號已更新為7-11');
    }
  } catch (error) {
    console.error('確保車位編號正確時出錯:', error);
  }
}

// 處理下一個充電請求
async function processNextChargingRequest() {
  try {
    const nextInQueue = await ChargingQueue.findOne().sort({ requestTime: 1 });
    if (!nextInQueue) {
      return;
    }
    
    const waitingSpot = await ParkingSpot.findOne({ 
      spotId: nextInQueue.spotId,
      status: '等待中'
    });
    
    if (waitingSpot) {
      // 設置為充電中但先不開始計時，記錄移動開始時間
      waitingSpot.status = '充電中';
      waitingSpot.moveStartTime = new Date();
      await waitingSpot.save();
      
      // 充電器移動完成後開始計時
      setTimeout(async () => {
        try {
          const updatedSpot = await ParkingSpot.findOne({ spotId: nextInQueue.spotId });
          if (updatedSpot && updatedSpot.status === '充電中' && !updatedSpot.startTime) {
            updatedSpot.startTime = new Date();
            await updatedSpot.save();
            await ChargingQueue.deleteOne({ _id: nextInQueue._id });
            await updateWaitingTimes();
            console.log(`車位 ${nextInQueue.spotId} 充電器移動完成，開始充電計時`);
          }
        } catch (error) {
          console.error('移動完成後更新下一個充電請求失敗:', error);
        }
      }, CABLE_MOVING_TIME * 1000);
    }
  } catch (error) {
    console.error('處理下一個充電請求失敗:', error);
  }
}

// 更新等待時間
async function updateWaitingTimes() {
  try {
    const chargingSpot = await ParkingSpot.findOne({ status: '充電中' });
    if (!chargingSpot) {
      return;
    }
    
    let cumulativeTime = 0;
    
    // 檢查充電中的車位是否在移動階段
    if (chargingSpot.moveStartTime && !chargingSpot.startTime) {
      const elapsedMoving = (new Date() - new Date(chargingSpot.moveStartTime)) / 1000;
      const remainingMoving = Math.max(0, CABLE_MOVING_TIME - elapsedMoving);
      cumulativeTime += remainingMoving / 60;
    }
    
    // 加上充電中的車位剩餘時間
    if (chargingSpot.startTime) {
      const elapsed = (new Date() - new Date(chargingSpot.startTime)) / (1000 * 60);
      const remainingCurrent = Math.max(0, chargingSpot.chargingTime - elapsed);
      cumulativeTime += remainingCurrent;
    } else {
      // 如果尚未開始計時，加上全部充電時間
      cumulativeTime += chargingSpot.chargingTime;
    }
    
    const queue = await ChargingQueue.find().sort({ requestTime: 1 });
    const waitingSpots = await ParkingSpot.find({ status: '等待中' });
    
    for (const queueItem of queue) {
      const waitingSpot = waitingSpots.find(ws => ws.spotId === queueItem.spotId);
      if (waitingSpot) {
        waitingSpot.waitingTime = cumulativeTime;
        await waitingSpot.save();
        
        // 加上這個等待車位的充電時間和移動時間
        cumulativeTime += waitingSpot.chargingTime;
        cumulativeTime += CABLE_MOVING_TIME / 60; // 移動時間轉換為分鐘
      }
    }
    
    console.log(`已更新所有等待中車位的等待時間，隊列長度: ${queue.length}`);
  } catch (error) {
    console.error('更新等待時間失敗:', error);
  }
}

// 檢查並重置已完成的車位
async function checkAndResetFinishedSpots() {
  try {
    const finishedSpots = await ParkingSpot.find({ status: '結束' });
    for (const spot of finishedSpots) {
      if (!spot.startTime) {
        spot.status = '空置中';
        spot.chargingTime = null;
        spot.userId = null;
        spot.moveStartTime = null;
        await spot.save();
        console.log(`車位 ${spot.spotId} 已重置為空置中 (無開始時間)`);
        continue;
      }
      
      const finishTime = new Date(spot.startTime);
      finishTime.setMinutes(finishTime.getMinutes() + spot.chargingTime);
      const now = new Date();
      const secondsSinceFinish = (now - finishTime) / 1000;
      
      if (secondsSinceFinish > 5) {
        spot.status = '空置中';
        spot.startTime = null;
        spot.chargingTime = null;
        spot.userId = null;
        spot.moveStartTime = null;
        await spot.save();
        console.log(`車位 ${spot.spotId} 已重置為空置中 (完成後${Math.floor(secondsSinceFinish)}秒)`);
      }
    }
  } catch (error) {
    console.error('檢查並重置結束狀態車位失敗:', error);
  }
}

// ======= API 路由 =======
// 獲取所有車位
app.get('/api/parking-spots', async (req, res) => {
  try {
    const spots = await ParkingSpot.find().sort({ spotId: 1 });
    
    // 統計各種狀態的車位數量
    const statusCounts = {
      total: spots.length,
      available: spots.filter(s => s.status === '空置中').length,
      charging: spots.filter(s => s.status === '充電中').length,
      waiting: spots.filter(s => s.status === '等待中').length,
      finished: spots.filter(s => s.status === '結束').length
    };
    
    // 美化輸出
    res.json({
      success: true,
      totalSpots: spots.length,
      statusSummary: statusCounts,
      spots: spots.map(spot => {
        let formattedSpot = {
          id: spot._id,
          spotId: spot.spotId,
          status: spot.status,
          userId: spot.userId || null
        };
        
        // 根據狀態添加額外信息
        if (spot.status === '充電中') {
          if (spot.startTime) {
            const elapsed = (new Date() - new Date(spot.startTime)) / 1000;
            const remainingSecs = Math.max(0, spot.chargingTime * 60 - elapsed);
            formattedSpot.chargingInfo = {
              startTime: spot.startTime,
              chargingTime: spot.chargingTime,
              elapsed: formatTime(elapsed),
              remaining: formatTime(remainingSecs),
              percentComplete: Math.round((elapsed / (spot.chargingTime * 60)) * 100)
            };
          } else if (spot.moveStartTime) {
            const elapsed = (new Date() - new Date(spot.moveStartTime)) / 1000;
            const remainingSecs = Math.max(0, CABLE_MOVING_TIME - elapsed);
            formattedSpot.movingInfo = {
              moveStartTime: spot.moveStartTime,
              remaining: formatTime(remainingSecs),
              percentComplete: Math.round((1 - remainingSecs / CABLE_MOVING_TIME) * 100)
            };
          }
        } else if (spot.status === '等待中') {
          formattedSpot.waitingInfo = {
            waitingTime: spot.waitingTime,
            formattedWaitingTime: spot.waitingTime ? `${Math.floor(spot.waitingTime)}分鐘` : "計算中..."
          };
        }
        
        return formattedSpot;
      })
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: '獲取停車位失敗',
      error: error.message
    });
  }
});

// 獲取充電隊列
app.get('/api/charging-queue', async (req, res) => {
  try {
    const queue = await ChargingQueue.find().sort({ requestTime: 1 });
    res.json({
      success: true,
      queueLength: queue.length,
      queue: queue
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: '獲取充電隊列失敗',
      error: error.message
    });
  }
});

// 獲取當前充電中的用戶
app.get('/api/charging-user', async (req, res) => {
  try {
    const chargingSpot = await ParkingSpot.findOne({ 
      status: '充電中',
      startTime: { $ne: null }
    });
    
    if (chargingSpot) {
      // 計算剩餘時間
      const elapsed = (new Date() - new Date(chargingSpot.startTime)) / 1000;
      const remainingSecs = Math.max(0, chargingSpot.chargingTime * 60 - elapsed);
      
      res.json({
        success: true,
        charging: true,
        spotId: chargingSpot.spotId,
        userId: chargingSpot.userId,
        startTime: chargingSpot.startTime,
        chargingTime: chargingSpot.chargingTime,
        remainingTime: formatTime(remainingSecs),
        percentComplete: Math.round((elapsed / (chargingSpot.chargingTime * 60)) * 100)
      });
    } else {
      res.json({
        success: true,
        charging: false,
        message: "目前沒有車位在充電中"
      });
    }
  } catch (error) {
    res.status(500).json({
      success: false,
      message: '獲取充電中的用戶失敗',
      error: error.message
    });
  }
});

// 獲取充電器移動狀態
app.get('/api/charging-move', async (req, res) => {
  try {
    // 查找有 moveStartTime 但尚未設置 startTime 的記錄
    const movingSpot = await ParkingSpot.findOne({ 
      moveStartTime: { $ne: null },
      startTime: null,
      status: '充電中' 
    });
    
    if (movingSpot) {
      const elapsed = (new Date() - new Date(movingSpot.moveStartTime)) / 1000;
      const remainingSecs = Math.max(0, CABLE_MOVING_TIME - elapsed);
      
      if (remainingSecs > 0) {
        // 美化輸出
        return res.json({
          success: true,
          isMoving: true,
          spotId: movingSpot.spotId,
          userId: movingSpot.userId,
          moveStartTime: movingSpot.moveStartTime,
          remainingMoveTime: remainingSecs,
          remainingMoveTimeFormatted: formatTime(remainingSecs),
          percentComplete: Math.round((1 - remainingSecs / CABLE_MOVING_TIME) * 100),
          message: `充電器正在移動至 ${movingSpot.spotId} 號車位，完成度 ${Math.round((1 - remainingSecs / CABLE_MOVING_TIME) * 100)}%`
        });
      }
    }
    
    // 如果沒有找到或移動已完成
    res.json({
      success: true,
      isMoving: false,
      message: "目前沒有充電器在移動中"
    });
  } catch (error) {
    res.status(500).json({ 
      success: false,
      message: '獲取充電器移動狀態失敗',
      error: error.message 
    });
  }
});

// 獲取單個車位信息
app.get('/api/parking-spot/:id', async (req, res) => {
  try {
    const spotId = parseInt(req.params.id);
    const spot = await ParkingSpot.findOne({ spotId });
    
    if (!spot) {
      return res.status(404).json({
        success: false,
        message: '找不到該車位',
        requestedId: spotId
      });
    }
    
    let remainingTimeString = "";
    let waitTimeForThisSpot = 0;
    
    // 檢查是否有正在移動中的充電器
    const movingSpot = await ParkingSpot.findOne({
      moveStartTime: { $ne: null },
      startTime: null,
      status: '充電中'
    });
    
    if (movingSpot) {
      const elapsed = (new Date() - new Date(movingSpot.moveStartTime)) / 1000;
      const remainingSecs = Math.max(0, CABLE_MOVING_TIME - elapsed);
      
      if (remainingSecs > 0) {
        remainingTimeString = `充電器移動中: ${formatTime(remainingSecs)}`;
        
        // 如果不是當前車位，還需要加入等待時間
        if (movingSpot.spotId !== spotId) {
          waitTimeForThisSpot += remainingSecs;
          waitTimeForThisSpot += movingSpot.chargingTime * 60;
        }
      }
    }
    
    // 檢查是否有充電中且已經開始計時的車位
    const chargingSpot = await ParkingSpot.findOne({ 
      status: '充電中',
      startTime: { $ne: null } 
    });
    
    if (chargingSpot) {
      const elapsed = (new Date() - new Date(chargingSpot.startTime)) / 1000;
      const remainingSecs = Math.max(0, chargingSpot.chargingTime * 60 - elapsed);
      
      // 只有在沒有移動中的充電器時或這個就是移動完畢的充電中車位時才顯示這個
      if (!remainingTimeString || (movingSpot && movingSpot.spotId === chargingSpot.spotId)) {
        remainingTimeString = formatTime(remainingSecs);
      }
      
      if (chargingSpot.spotId !== spotId) {
        waitTimeForThisSpot += remainingSecs;
      }
    }
    
    if (spot.status !== '充電中') {
      const queue = await ChargingQueue.find().sort({ requestTime: 1 });
      let foundCurrent = false;
      let positionInQueue = -1;
      
      for (let i = 0; i < queue.length; i++) {
        if (queue[i].spotId === spotId) {
          foundCurrent = true;
          positionInQueue = i;
          break;
        }
        waitTimeForThisSpot += queue[i].chargingTime * 60;
        waitTimeForThisSpot += CABLE_MOVING_TIME; // 每次切換都要加上移動時間
      }
      
      // 格式化響應
      const response = {
        success: true,
        spot: {
          id: spot._id,
          spotId: spot.spotId,
          status: spot.status,
          userId: spot.userId || null,
          chargingTime: spot.chargingTime,
          startTime: spot.startTime,
          waitingTime: spot.waitingTime,
          moveStartTime: spot.moveStartTime
        },
        chargingInfo: {
          isCharging: spot.status === '充電中',
          isMoving: spot.moveStartTime && !spot.startTime && spot.status === '充電中',
          chargingSpotRemainingTime: remainingTimeString,
          estimatedWaitTime: formatTime(waitTimeForThisSpot),
          estimatedWaitTimeSeconds: waitTimeForThisSpot
        },
        queueInfo: {
          position: positionInQueue >= 0 ? positionInQueue + 1 : -1,
          queueLength: queue.length
        }
      };
      
      return res.json(response);
    }
    
    // 如果是充電中的車位，直接構建響應
    const response = {
      success: true,
      spot: {
        id: spot._id,
        spotId: spot.spotId,
        status: spot.status,
        userId: spot.userId || null,
        chargingTime: spot.chargingTime,
        startTime: spot.startTime,
        moveStartTime: spot.moveStartTime
      },
      chargingInfo: {
        isCharging: true,
        isMoving: spot.moveStartTime && !spot.startTime,
        chargingSpotRemainingTime: remainingTimeString
      },
      queueInfo: {
        position: -1,
        queueLength: await ChargingQueue.countDocuments()
      }
    };
    
    res.json(response);
  } catch (error) {
    res.status(500).json({
      success: false,
      message: '獲取車位失敗',
      error: error.message
    });
  }
});

// 請求充電
app.post('/api/request-charging', async (req, res) => {
  const { spotId, chargingTime, userId } = req.body;
  if (!spotId || chargingTime === undefined || !userId) {
    return res.status(400).json({
      success: false,
      message: '缺少必要參數'
    });
  }
  
  try {
    const existingRequest = await ParkingSpot.findOne({ 
      userId: userId,
      status: { $in: ['充電中', '等待中'] }
    });
    
    if (existingRequest) {
      return res.status(403).json({
        success: false,
        message: '您已有一個充電請求',
        existingRequest: {
          spotId: existingRequest.spotId,
          status: existingRequest.status
        }
      });
    }
    
    const spot = await ParkingSpot.findOne({ spotId: parseInt(spotId) });
    if (!spot) {
      return res.status(404).json({
        success: false,
        message: '找不到該車位'
      });
    }
    
    if (spot.status !== '空置中') {
      return res.status(403).json({
        success: false,
        message: '該車位已被佔用',
        currentStatus: spot.status
      });
    }
    
    const chargingSpot = await ParkingSpot.findOne({ status: '充電中' });
    
    if (!chargingSpot) {
      // 設置充電狀態但先不開始計時，記錄移動開始時間
      spot.status = '充電中';
      spot.moveStartTime = new Date(); // 記錄移動開始時間
      spot.chargingTime = chargingTime;
      spot.userId = userId;
      await spot.save();
      
      // 設定定時器，在移動完成後開始充電計時
      setTimeout(async () => {
        try {
          const updatedSpot = await ParkingSpot.findOne({ spotId: parseInt(spotId) });
          if (updatedSpot && updatedSpot.status === '充電中' && !updatedSpot.startTime) {
            updatedSpot.startTime = new Date(); // 開始計時
            await updatedSpot.save();
            console.log(`車位 ${spotId} 充電器移動完成，開始充電計時`);
          }
        } catch (error) {
          console.error('移動完成後更新狀態失敗:', error);
        }
      }, CABLE_MOVING_TIME * 1000);
      
      return res.json({
        success: true,
        message: '充電器正在移動中，請稍後',
        spot: {
          spotId: spot.spotId,
          status: spot.status,
          moveStartTime: spot.moveStartTime,
          chargingTime: spot.chargingTime,
          userId: spot.userId
        }
      });
    } else {
      // 已有車位在充電，加入等待隊列
      spot.status = '等待中';
      spot.chargingTime = chargingTime;
      spot.userId = userId;
      
      let totalWaitingTime = 0;
      
      // 檢查充電中的車位是否仍在移動階段
      if (chargingSpot.moveStartTime && !chargingSpot.startTime) {
        const elapsedMoving = (new Date() - new Date(chargingSpot.moveStartTime)) / 1000;
        const remainingMoving = Math.max(0, CABLE_MOVING_TIME - elapsedMoving);
        totalWaitingTime += remainingMoving / 60;
      }
      
      // 計算充電中車位的剩餘時間
      if (chargingSpot.startTime) {
        const elapsed = (new Date() - new Date(chargingSpot.startTime)) / (1000 * 60);
        const remainingCurrent = Math.max(0, chargingSpot.chargingTime - elapsed);
        totalWaitingTime += remainingCurrent;
      } else {
        // 如果尚未開始計時，加上全部充電時間
        totalWaitingTime += chargingSpot.chargingTime;
      }
      
      // 計算隊列中其他等待者的時間
      const waitingSpots = await ParkingSpot.find({ status: '等待中' });
      const queue = await ChargingQueue.find().sort({ requestTime: 1 });
      
      for (const queueItem of queue) {
        const waitingSpot = waitingSpots.find(ws => ws.spotId === queueItem.spotId);
        if (waitingSpot) {
          totalWaitingTime += waitingSpot.chargingTime;
          totalWaitingTime += CABLE_MOVING_TIME / 60; // 每個等待者還要加上移動時間
        }
      }
      
      spot.waitingTime = totalWaitingTime;
      await spot.save();
      
      await new ChargingQueue({
        userId,
        spotId: parseInt(spotId),
        chargingTime
      }).save();
      
      await updateWaitingTimes();
      return res.json({
        success: true,
        message: '已加入充電隊列',
        position: queue.length + 1,
        estimatedWaitTime: `${Math.floor(totalWaitingTime)}分鐘`,
        spot: {
          spotId: spot.spotId,
          status: spot.status,
          chargingTime: spot.chargingTime,
          waitingTime: spot.waitingTime,
          userId: spot.userId
        }
      });
    }
  } catch (error) {
    console.error('處理充電請求失敗:', error);
    res.status(500).json({
      success: false,
      message: '處理請求失敗',
      error: error.message
    });
  }
});

// 取消充電
app.post('/api/cancel-charging', async (req, res) => {
  const { spotId, userId } = req.body;
  if (!spotId || !userId) {
    return res.status(400).json({
      success: false,
      message: '缺少必要參數'
    });
  }
  
  try {
    const spot = await ParkingSpot.findOne({ 
      spotId: parseInt(spotId),
      userId: userId
    });
    
    if (!spot) {
      return res.status(404).json({
        success: false,
        message: '找不到您的充電請求'
      });
    }
    
    const oldStatus = spot.status;
    spot.status = '空置中';
    spot.startTime = null;
    spot.chargingTime = null;
    spot.waitingTime = null;
    spot.userId = null;
    spot.moveStartTime = null;
    await spot.save();
    
    await ChargingQueue.deleteOne({ userId, spotId: parseInt(spotId) });
    
    if (oldStatus === '充電中') {
      await processNextChargingRequest();
    } else if (oldStatus === '等待中') {
      await updateWaitingTimes();
    }
    
    res.json({
      success: true,
      message: '充電請求已取消',
      oldStatus: oldStatus
    });
  } catch (error) {
    console.error('取消充電請求失敗:', error);
    res.status(500).json({
      success: false,
      message: '處理請求失敗',
      error: error.message
    });
  }
});

// 定時檢查結束狀態的車位
setInterval(checkAndResetFinishedSpots, 1000);

// 定時檢查充電狀態
setInterval(async () => {
  try {
    // 只檢查已開始計時的充電中車位
    const chargingSpot = await ParkingSpot.findOne({ 
      status: '充電中',
      startTime: { $ne: null }
    });
    
    if (chargingSpot && chargingSpot.chargingTime) {
      const elapsedMinutes = (new Date() - new Date(chargingSpot.startTime)) / (1000 * 60);
      if (elapsedMinutes >= chargingSpot.chargingTime) {
        chargingSpot.status = '結束';
        await chargingSpot.save();
        console.log(`車位 ${chargingSpot.spotId} 充電完成`);
        await processNextChargingRequest();
      }
    }
  } catch (error) {
    console.error('檢查充電狀態失敗:', error);
  }
}, 1000);

// 啟動服務前確保車位設置正確
initParkingSpots()
  .then(() => initializeAllSpots())
  .then(() => ensureCorrectSpotIds())
  .then(() => {
    app.listen(PORT, () => {
      console.log(`伺服器運行在 http://localhost:${PORT}`);
    });
  })
  .catch(err => {
    console.error('啟動服務失敗:', err);
  });
