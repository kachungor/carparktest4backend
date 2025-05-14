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

// ======= 更新資料結構，增加 cableMoving 欄位 =======
const ParkingSpotSchema = new mongoose.Schema({
  spotId: { type: Number, required: true, unique: true },
  status: { 
    type: String, 
    enum: ['空置中', '充電中', '等待中', '結束', '移動中'],
    default: '空置中'
  },
  startTime: { type: Date },
  chargingTime: { type: Number },   // 充電時間（分鐘）
  waitingTime: { type: Number },    // 等待時間（分鐘）
  userId: { type: String },         // 使用者ID
  moveStartTime: { type: Date }     // 充電器移動開始時間
});

const ParkingSpot = mongoose.model('ParkingSpot', ParkingSpotSchema);

const QueueSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  spotId: { type: Number, required: true },
  chargingTime: { type: Number, required: true },
  requestTime: { type: Date, default: Date.now }
});

const ChargingQueue = mongoose.model('ChargingQueue', QueueSchema);

// 定義充電器移動時間（秒）
const CABLE_MOVING_TIME = 30; // 30秒

async function initParkingSpots() {
  try {
    const count = await ParkingSpot.countDocuments();
    if (count === 0) {
      // 增加到11個車位
      const initialSpots = [];
      for (let i = 1; i <= 11; i++) {
        initialSpots.push({ spotId: i, status: '空置中' });
      }
      await ParkingSpot.insertMany(initialSpots);
      console.log('停車位初始化完成');
    } else if (count < 11) {
      // 如果原有車位少於11個，增加剩餘車位
      const maxSpotId = await ParkingSpot.findOne().sort({ spotId: -1 });
      const currentMax = maxSpotId ? maxSpotId.spotId : 0;
      
      const additionalSpots = [];
      for (let i = currentMax + 1; i <= 11; i++) {
        additionalSpots.push({ spotId: i, status: '空置中' });
      }
      
      if (additionalSpots.length > 0) {
        await ParkingSpot.insertMany(additionalSpots);
        console.log(`增加了 ${additionalSpots.length} 個車位`);
      }
    }
  } catch (error) {
    console.error('初始化停車位失敗:', error);
  }
}

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

initParkingSpots().then(() => {
  initializeAllSpots();
});

app.get('/api/parking-spots', async (req, res) => {
  try {
    const spots = await ParkingSpot.find().sort({ spotId: 1 });
    res.json(spots);
  } catch (error) {
    res.status(500).json({ message: '獲取停車位失敗', error: error.message });
  }
});

app.get('/api/charging-queue', async (req, res) => {
  try {
    const queue = await ChargingQueue.find().sort({ requestTime: 1 });
    res.json(queue);
  } catch (error) {
    res.status(500).json({ message: '獲取充電隊列失敗', error: error.message });
  }
});

app.get('/api/charging-user', async (req, res) => {
  try {
    const chargingSpot = await ParkingSpot.findOne({ status: '充電中' });
    res.json(chargingSpot);
  } catch (error) {
    res.status(500).json({ message: '獲取充電中的用戶失敗', error: error.message });
  }
});

// 新增充電器移動狀態端點
app.get('/api/charging-move', async (req, res) => {
  try {
    const movingSpot = await ParkingSpot.findOne({ status: '移動中' });
    res.json(movingSpot);
  } catch (error) {
    res.status(500).json({ message: '獲取充電器移動狀態失敗', error: error.message });
  }
});

app.get('/api/parking-spot/:id', async (req, res) => {
  try {
    const spotId = parseInt(req.params.id);
    const spot = await ParkingSpot.findOne({ spotId });
    if (!spot) {
      return res.status(404).json({ message: '找不到該車位' });
    }

    let remainingTimeString = "";
    let waitTimeForThisSpot = 0;
    
    // 檢查是否有移動中的充電器
    const movingSpot = await ParkingSpot.findOne({ status: '移動中' });
    if (movingSpot) {
      const elapsed = (new Date() - new Date(movingSpot.moveStartTime)) / 1000;
      const remainingSecs = Math.max(0, CABLE_MOVING_TIME - elapsed);
      
      // 如果還在移動中，加入移動時間
      if (remainingSecs > 0) {
        const remainingMins = Math.floor(remainingSecs / 60);
        const remainingSec = Math.floor(remainingSecs % 60);
        remainingTimeString = `充電器移動中: ${remainingMins}分${remainingSec}秒`;
        waitTimeForThisSpot += remainingSecs;
      }
    }
    
    // 檢查是否有充電中的車位
    const chargingSpot = await ParkingSpot.findOne({ status: '充電中' });
    if (chargingSpot) {
      const elapsed = (new Date() - new Date(chargingSpot.startTime)) / 1000;
      const remainingSecs = Math.max(0, chargingSpot.chargingTime * 60 - elapsed);
      const remainingMins = Math.floor(remainingSecs / 60);
      const remainingSec = Math.floor(remainingSecs % 60);
      
      // 只有在沒有移動中的充電器時才顯示這個
      if (!remainingTimeString) {
        remainingTimeString = `${remainingMins}分${remainingSec}秒`;
      }
      
      if (chargingSpot.spotId !== spotId) {
        waitTimeForThisSpot += remainingSecs;
      }
    }
    
    if (spot.status !== '充電中' && spot.status !== '移動中') {
      const queue = await ChargingQueue.find().sort({ requestTime: 1 });
      let foundCurrent = false;
      for (const queueItem of queue) {
        if (queueItem.spotId === spotId) {
          foundCurrent = true;
          break;
        }
        waitTimeForThisSpot += queueItem.chargingTime * 60;
      }
    }
    
    const waitMins = Math.floor(waitTimeForThisSpot / 60);
    const waitSecs = Math.floor(waitTimeForThisSpot % 60);
    const waitTimeString = waitTimeForThisSpot > 0 ? `${waitMins}分${waitSecs}秒` : "";
    
    res.json({
      ...spot.toObject(),
      chargingSpotRemainingTime: remainingTimeString,
      estimatedWaitTime: waitTimeString,
      estimatedWaitTimeSeconds: waitTimeForThisSpot
    });
  } catch (error) {
    res.status(500).json({ message: '獲取車位失敗', error: error.message });
  }
});

app.post('/api/request-charging', async (req, res) => {
  const { spotId, chargingTime, userId } = req.body;
  if (!spotId || chargingTime === undefined || !userId) {
    return res.status(400).json({ message: '缺少必要參數' });
  }
  
  try {
    // 檢查用戶是否已有充電請求
    const existingRequest = await ParkingSpot.findOne({ 
      userId: userId,
      status: { $in: ['充電中', '等待中', '移動中'] }
    });
    
    if (existingRequest) {
      return res.status(403).json({ message: '您已有一個充電請求' });
    }
    
    const spot = await ParkingSpot.findOne({ spotId: parseInt(spotId) });
    if (!spot) {
      return res.status(404).json({ message: '找不到該車位' });
    }
    
    if (spot.status !== '空置中') {
      return res.status(403).json({ message: '該車位已被佔用' });
    }
    
    // 檢查是否有正在充電或移動中的車位
    const chargingSpot = await ParkingSpot.findOne({ status: '充電中' });
    const movingSpot = await ParkingSpot.findOne({ status: '移動中' });
    
    if (!chargingSpot && !movingSpot) {
      // 先設為移動中，然後等移動時間結束後開始充電
      spot.status = '移動中';
      spot.moveStartTime = new Date();
      spot.chargingTime = chargingTime;
      spot.userId = userId;
      await spot.save();
      
      // 設定定時器，在移動完成後開始充電
      setTimeout(async () => {
        try {
          const updatedSpot = await ParkingSpot.findOne({ spotId: parseInt(spotId) });
          if (updatedSpot && updatedSpot.status === '移動中') {
            updatedSpot.status = '充電中';
            updatedSpot.startTime = new Date();
            await updatedSpot.save();
            console.log(`車位 ${spotId} 充電器移動完成，開始充電`);
          }
        } catch (error) {
          console.error('移動完成後更新狀態失敗:', error);
        }
      }, CABLE_MOVING_TIME * 1000);
      
      return res.json({ message: '充電器正在移動中', spot });
    } else {
      // 已有車位在充電或移動中，加入等待隊列
      spot.status = '等待中';
      spot.chargingTime = chargingTime;
      spot.userId = userId;
      
      let totalWaitingTime = 0;
      
      // 計算等待時間，包括充電器移動時間
      if (movingSpot) {
        const elapsedMoving = (new Date() - new Date(movingSpot.moveStartTime)) / 1000;
        const remainingMoving = Math.max(0, CABLE_MOVING_TIME - elapsedMoving);
        totalWaitingTime += remainingMoving / 60;
      }
      
      if (chargingSpot) {
        const elapsed = (new Date() - new Date(chargingSpot.startTime)) / (1000 * 60);
        const remainingCurrent = Math.max(0, chargingSpot.chargingTime - elapsed);
        totalWaitingTime += remainingCurrent;
      }
      
      // 計算隊列中其他等待者的時間
      const waitingSpots = await ParkingSpot.find({ status: '等待中' });
      const queue = await ChargingQueue.find().sort({ requestTime: 1 });
      
      for (const queueItem of queue) {
        const waitingSpot = waitingSpots.find(ws => ws.spotId === queueItem.spotId);
        if (waitingSpot) {
          totalWaitingTime += waitingSpot.chargingTime;
        }
      }
      
      // 每次切換車位還需要額外的移動時間
      totalWaitingTime += (queue.length * CABLE_MOVING_TIME) / 60;
      
      spot.waitingTime = totalWaitingTime;
      await spot.save();
      
      await new ChargingQueue({
        userId,
        spotId: parseInt(spotId),
        chargingTime
      }).save();
      
      await updateWaitingTimes();
      return res.json({ message: '已加入充電隊列', spot });
    }
  } catch (error) {
    console.error('處理充電請求失敗:', error);
    res.status(500).json({ message: '處理請求失敗', error: error.message });
  }
});

app.post('/api/cancel-charging', async (req, res) => {
  const { spotId, userId } = req.body;
  if (!spotId || !userId) {
    return res.status(400).json({ message: '缺少必要參數' });
  }
  
  try {
    const spot = await ParkingSpot.findOne({ 
      spotId: parseInt(spotId),
      userId: userId
    });
    
    if (!spot) {
      return res.status(404).json({ message: '找不到您的充電請求' });
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
    
    if (oldStatus === '充電中' || oldStatus === '移動中') {
      await processNextChargingRequest();
    } else if (oldStatus === '等待中') {
      await updateWaitingTimes();
    }
    
    res.json({ message: '充電請求已取消' });
  } catch (error) {
    console.error('取消充電請求失敗:', error);
    res.status(500).json({ message: '處理請求失敗', error: error.message });
  }
});

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
      // 首先設置為移動中
      waitingSpot.status = '移動中';
      waitingSpot.moveStartTime = new Date();
      await waitingSpot.save();
      
      // 移動完成後開始充電
      setTimeout(async () => {
        try {
          const updatedSpot = await ParkingSpot.findOne({ spotId: nextInQueue.spotId });
          if (updatedSpot && updatedSpot.status === '移動中') {
            updatedSpot.status = '充電中';
            updatedSpot.startTime = new Date();
            await updatedSpot.save();
            await ChargingQueue.deleteOne({ _id: nextInQueue._id });
            await updateWaitingTimes();
            console.log(`車位 ${nextInQueue.spotId} 充電器移動完成，開始充電`);
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

async function updateWaitingTimes() {
  try {
    // 檢查是否有移動中或充電中的車位
    const movingSpot = await ParkingSpot.findOne({ status: '移動中' });
    const chargingSpot = await ParkingSpot.findOne({ status: '充電中' });
    
    let cumulativeTime = 0;
    
    // 計算移動中的剩餘時間
    if (movingSpot) {
      const elapsedMoving = (new Date() - new Date(movingSpot.moveStartTime)) / 1000;
      const remainingMoving = Math.max(0, CABLE_MOVING_TIME - elapsedMoving);
      cumulativeTime += remainingMoving / 60;
      
      // 再加上移動完成後的充電時間
      cumulativeTime += movingSpot.chargingTime;
    }
    
    // 計算充電中的剩餘時間
    if (chargingSpot) {
      const elapsed = (new Date() - new Date(chargingSpot.startTime)) / (1000 * 60);
      const remainingCharging = Math.max(0, chargingSpot.chargingTime - elapsed);
      cumulativeTime += remainingCharging;
    }
    
    // 更新所有等待中車位的等待時間
    const queue = await ChargingQueue.find().sort({ requestTime: 1 });
    const waitingSpots = await ParkingSpot.find({ status: '等待中' });
    
    let queuePosition = 0;
    for (const queueItem of queue) {
      const waitingSpot = waitingSpots.find(ws => ws.spotId === queueItem.spotId);
      if (waitingSpot) {
        // 每次換車位時都要加上充電器移動時間
        if (queuePosition > 0) {
          cumulativeTime += CABLE_MOVING_TIME / 60;
        }
        
        waitingSpot.waitingTime = cumulativeTime;
        await waitingSpot.save();
        cumulativeTime += waitingSpot.chargingTime;
        queuePosition++;
      }
    }
    
    console.log(`已更新所有等待中車位的等待時間，隊列長度: ${queue.length}`);
  } catch (error) {
    console.error('更新等待時間失敗:', error);
  }
}

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

// 檢查結束狀態車位
setInterval(checkAndResetFinishedSpots, 1000);

// 檢查充電狀態
setInterval(async () => {
  try {
    const chargingSpot = await ParkingSpot.findOne({ status: '充電中' });
    if (chargingSpot && chargingSpot.startTime && chargingSpot.chargingTime) {
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

app.listen(PORT, () => {
  console.log(`伺服器運行在 http://localhost:${PORT}`);
});
