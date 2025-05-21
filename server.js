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

// ======= 以下原有程式碼保持不變 =======
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
});

const ParkingSpot = mongoose.model('ParkingSpot', ParkingSpotSchema);

const QueueSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  spotId: { type: Number, required: true },
  chargingTime: { type: Number, required: true },
  requestTime: { type: Date, default: Date.now }
});

const ChargingQueue = mongoose.model('ChargingQueue', QueueSchema);

async function initParkingSpots() {
  try {
    const count = await ParkingSpot.countDocuments();
    if (count === 0) {
      const initialSpots = [];
      for (let i = 1; i <= 3; i++) {
        initialSpots.push({ spotId: i, status: '空置中' });
      }
      await ParkingSpot.insertMany(initialSpots);
      console.log('停車位初始化完成');
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
          userId: null
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
    res.status(500).json({ message: '獲取充電隊列失敗', error: error.message });
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
    const chargingSpot = await ParkingSpot.findOne({ status: '充電中' });
    if (chargingSpot) {
      const elapsed = (new Date() - new Date(chargingSpot.startTime)) / 1000;
      const remainingSecs = Math.max(0, chargingSpot.chargingTime * 60 - elapsed);
      const remainingMins = Math.floor(remainingSecs / 60);
      const remainingSec = Math.floor(remainingSecs % 60);
      remainingTimeString = `${remainingMins}分${remainingSec}秒`;
      if (chargingSpot.spotId !== spotId) {
        waitTimeForThisSpot = remainingSecs;
      }
    }
    if (spot.status !== '充電中') {
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
    const existingRequest = await ParkingSpot.findOne({ 
      userId: userId,
      status: { $in: ['充電中', '等待中'] }
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
    const chargingSpot = await ParkingSpot.findOne({ status: '充電中' });
    if (!chargingSpot) {
      spot.status = '充電中';
      spot.startTime = new Date();
      spot.chargingTime = chargingTime;
      spot.userId = userId;
      await spot.save();
      return res.json({ message: '充電已開始', spot });
    } else {
      spot.status = '等待中';
      spot.chargingTime = chargingTime;
      spot.userId = userId;
      let totalWaitingTime = 0;
      const currentChargingSpot = chargingSpot;
      const elapsed = (new Date() - new Date(currentChargingSpot.startTime)) / (1000 * 60);
      const remainingCurrent = Math.max(0, currentChargingSpot.chargingTime - elapsed);
      totalWaitingTime += remainingCurrent;
      const waitingSpots = await ParkingSpot.find({ status: '等待中' });
      const queue = await ChargingQueue.find().sort({ requestTime: 1 });
      for (const queueItem of queue) {
        const waitingSpot = waitingSpots.find(ws => ws.spotId === queueItem.spotId);
        if (waitingSpot) {
          totalWaitingTime += waitingSpot.chargingTime;
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
    await spot.save();
    await ChargingQueue.deleteOne({ userId, spotId: parseInt(spotId) });
    if (oldStatus === '充電中') {
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
      waitingSpot.status = '充電中';
      waitingSpot.startTime = new Date();
      await waitingSpot.save();
      await ChargingQueue.deleteOne({ _id: nextInQueue._id });
      await updateWaitingTimes();
    }
  } catch (error) {
    console.error('處理下一個充電請求失敗:', error);
  }
}

async function updateWaitingTimes() {
  try {
    const chargingSpot = await ParkingSpot.findOne({ status: '充電中' });
    if (!chargingSpot) {
      return;
    }
    const elapsed = (new Date() - new Date(chargingSpot.startTime)) / (1000 * 60);
    let cumulativeTime = Math.max(0, chargingSpot.chargingTime - elapsed);
    const queue = await ChargingQueue.find().sort({ requestTime: 1 });
    const waitingSpots = await ParkingSpot.find({ status: '等待中' });
    for (const queueItem of queue) {
      const waitingSpot = waitingSpots.find(ws => ws.spotId === queueItem.spotId);
      if (waitingSpot) {
        waitingSpot.waitingTime = cumulativeTime;
        await waitingSpot.save();
        cumulativeTime += waitingSpot.chargingTime;
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
        await spot.save();
        console.log(`車位 ${spot.spotId} 已重置為空置中 (完成後${Math.floor(secondsSinceFinish)}秒)`);
      }
    }
  } catch (error) {
    console.error('檢查並重置結束狀態車位失敗:', error);
  }
}

setInterval(checkAndResetFinishedSpots, 1000);

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
