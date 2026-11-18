require("dotenv").config();
const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const app = express();
app.use(cors({ origin: process.env.FRONTEND_URL || "*" }));
app.use(express.json({ limit: "1mb" }));

// Data is never deleted: DELETE requests are rejected everywhere.
app.use((req, res, next) => (req.method === "DELETE" ? res.status(405).json({ error: "Deletion is disabled" }) : next()));

const { Schema, model, Types } = mongoose;

const User = model("User", new Schema({
  role: { type: String, enum: ["freelancer", "client"], required: true },
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  pass: { type: String, required: true },
  company: String, category: String, title: String, bio: String,
  rate: { type: Number, default: 0 }, cv: String,
  skills: [String], rating: { type: Number, default: 0 }, done: { type: Number, default: 0 },
  samples: [{ title: String, link: String }]
}, { timestamps: true }));

const Project = model("Project", new Schema({
  ownerId: { type: Types.ObjectId, ref: "User", required: true },
  title: { type: String, required: true }, category: String,
  type: { type: String, enum: ["Remote", "Onsite"] }, budget: Number, desc: String,
  status: { type: String, default: "open" }
}, { timestamps: true }));

const Proposal = model("Proposal", new Schema({
  projectId: { type: Types.ObjectId, ref: "Project", required: true },
  seekerId: { type: Types.ObjectId, ref: "User", required: true },
  bid: Number, msg: String,
  status: { type: String, default: "pending" },
  esc: { state: String, file: String, start: Date, end: Date, used6: { type: Boolean, default: false }, pauseUntil: Date, autoReleased: Boolean }
}, { timestamps: true }));

const Message = model("Message", new Schema({
  threadKey: { type: String, index: true }, from: String, text: String,
  offer: { pid: String, title: String, budget: Number }, accepted: { type: Boolean, default: false }
}, { timestamps: true }));

const Payment = model("Payment", new Schema({
  proposalId: Types.ObjectId, amount: Number, method: String, txn: String
}, { timestamps: true }));

const Report = model("Report", new Schema({
  by: String, target: String, reason: String, details: String, status: { type: String, default: "Under review" }
}, { timestamps: true }));

const clean = (doc) => { const o = doc.toObject(); delete o.pass; delete o.__v; return o; };

// ---------- Health ----------
app.get("/api/health", (req, res) => res.json({ ok: true }));

// ---------- Auth (simple; add JWT before going live) ----------
app.post("/api/auth/signup", async (req, res) => {
  try {
    const { role, name, email, pass, category, company } = req.body;
    if (!role || !name || !email || !pass) return res.status(400).json({ error: "Missing fields" });
    if (await User.findOne({ email: email.toLowerCase() })) return res.status(409).json({ error: "Email already exists" });
    const u = await User.create({ role, name, email, pass: await bcrypt.hash(pass, 10), category, company });
    res.status(201).json(clean(u));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, pass, role } = req.body;
    const u = await User.findOne({ email: String(email).toLowerCase(), role });
    if (!u || !(await bcrypt.compare(pass, u.pass))) return res.status(401).json({ error: "Wrong email or password" });
    res.json(clean(u));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- Users / freelancer profiles ----------
app.get("/api/users", async (req, res) => {
  const f = {};
  if (req.query.role) f.role = req.query.role;
  if (req.query.category && req.query.category !== "All") f.category = req.query.category;
  res.json((await User.find(f).sort({ createdAt: 1 })).map(clean));
});

app.patch("/api/users/:id", async (req, res) => {
  const { pass, _id, role, email, ...rest } = req.body; // password/role/email are not editable here
  const u = await User.findByIdAndUpdate(req.params.id, rest, { new: true });
  res.json(u ? clean(u) : null);
});

// ---------- Projects (jobs) ----------
app.get("/api/projects", async (req, res) => {
  const f = {};
  if (req.query.status) f.status = req.query.status;
  if (req.query.type && req.query.type !== "All") f.type = req.query.type;
  if (req.query.category && req.query.category !== "All") f.category = req.query.category;
  if (req.query.ownerId) f.ownerId = req.query.ownerId;
  if (req.query.q) {
    const r = new RegExp(req.query.q.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    f.$or = [{ title: r }, { category: r }, { desc: r }, { type: r }];
  }
  res.json(await Project.find(f).sort({ createdAt: -1 }));
});

app.post("/api/projects", async (req, res) => {
  res.status(201).json(await Project.create(req.body));
});

// ---------- Proposals + escrow ----------
app.get("/api/proposals", async (req, res) => {
  const f = {};
  if (req.query.seekerId) f.seekerId = req.query.seekerId;
  if (req.query.clientId) {
    const ids = (await Project.find({ ownerId: req.query.clientId }).select("_id")).map((p) => p._id);
    f.projectId = { $in: ids };
  }
  res.json(await Proposal.find(f).sort({ createdAt: -1 }));
});

app.post("/api/proposals", async (req, res) => {
  const p = await Proposal.create({ ...req.body, status: "pending" });
  res.status(201).json(p);
});

// action: hire | fund | submit | release | pause
app.patch("/api/proposals/:id", async (req, res) => {
  try {
    const p = await Proposal.findById(req.params.id);
    if (!p) return res.status(404).json({ error: "Not found" });
    const project = await Project.findById(p.projectId);
    const t = new Date();
    const { action, userId, file, start, mins, hours, method } = req.body;

    switch (action) {
      case "hire":
        if (String(project.ownerId) !== String(userId)) return res.status(403).json({ error: "Only the client can hire" });
        await Proposal.updateMany({ projectId: project._id, _id: { $ne: p._id } }, { status: "rejected" });
        p.status = "hired";
        p.set("esc", { state: "unfunded" });
        project.status = "hired";
        await project.save();
        break;
      case "fund":
        if (String(project.ownerId) !== String(userId)) return res.status(403).json({ error: "Only the client can pay" });
        await Payment.create({ proposalId: p._id, amount: p.bid, method: method || "Card", txn: "TXN" + Date.now().toString(36).toUpperCase() });
        p.set("esc.state", "funded");
        break;
      case "submit": {
        if (String(p.seekerId) !== String(userId)) return res.status(403).json({ error: "Only the freelancer can submit" });
        const s = start ? new Date(start) : t;
        const m = Math.min(60, Math.max(5, Number(mins) || 5));
        p.set("esc", { ...p.esc.toObject(), state: "viewing", file, start: s, end: new Date(s.getTime() + m * 60000) });
        break;
      }
      case "release":
        if (String(project.ownerId) !== String(userId)) return res.status(403).json({ error: "Only the client can release" });
        p.set("esc.state", "released");
        break;
      case "pause": {
        if (String(project.ownerId) !== String(userId)) return res.status(403).json({ error: "Only the client can pause" });
        const used = p.esc.used6;
        const h = used ? Math.min(72, Math.max(3, Number(hours) || 3)) : 6;
        p.set("esc.used6", true);
        p.set("esc.state", "paused");
        p.set("esc.pauseUntil", new Date(t.getTime() + h * 3600000));
        break;
      }
      default:
        return res.status(400).json({ error: "Unknown action" });
    }
    await p.save();
    res.json(p);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- Chat + job offers (threadKey: "d:clientId:freelancerId" or proposal id) ----------
app.get("/api/chats/:key", async (req, res) => {
  res.json(await Message.find({ threadKey: req.params.key }).sort({ createdAt: 1 }));
});

app.post("/api/chats/:key", async (req, res) => {
  const m = await Message.create({ threadKey: req.params.key, from: req.body.from, text: req.body.text, offer: req.body.offer });
  res.status(201).json(m);
});

app.post("/api/chats/:key/:msgId/accept", async (req, res) => {
  const m = await Message.findById(req.params.msgId);
  if (!m || !m.offer || !m.offer.pid) return res.status(404).json({ error: "Offer not found" });
  const p = await Proposal.create({
    projectId: m.offer.pid, seekerId: req.body.freelancerId, bid: m.offer.budget,
    msg: "Accepted job offer", status: "hired", esc: { state: "unfunded" }
  });
  await Project.findByIdAndUpdate(m.offer.pid, { status: "hired" });
  m.accepted = true;
  await m.save();
  res.json({ message: m, proposal: p });
});

// ---------- Payments + reports ----------
app.get("/api/payments", async (req, res) => {
  const f = req.query.proposalId ? { proposalId: req.query.proposalId } : {};
  res.json(await Payment.find(f).sort({ createdAt: -1 }));
});

app.post("/api/reports", async (req, res) => {
  res.status(201).json(await Report.create(req.body));
});

app.get("/api/reports", async (req, res) => {
  const f = req.query.by ? { by: req.query.by } : {};
  res.json(await Report.find(f).sort({ createdAt: -1 }));
});

// ---------- Escrow timers: auto release + pause expiry ----------
async function escrowTick() {
  const now = new Date();
  await Proposal.updateMany({ "esc.state": "viewing", "esc.end": { $lte: now } },
    { $set: { "esc.state": "released", "esc.autoReleased": true } });
  await Proposal.updateMany({ "esc.state": "paused", "esc.pauseUntil": { $lte: now } },
    { $set: { "esc.state": "revision" } });
}

// ---------- Start ----------
const PORT = process.env.PORT || 4000;
mongoose.set("strictQuery", true);
mongoose.connect(process.env.MONGODB_URI).then(async () => {
  if ((await User.countDocuments()) === 0) {
    const pass = await bcrypt.hash("1234", 10);
    await User.create([
      { role: "client", name: "Mahim Hasan", email: "mahim@demo.com", pass, company: "Mahim Studio" },
      { role: "freelancer", name: "Pritom Saha", email: "pritom@demo.com", pass, category: "Web Development", title: "Full-Stack Developer", bio: "React and Node.js builds.", rate: 25, skills: ["React", "Node.js"] }
    ]);
    console.log("Demo users created");
  }
  setInterval(() => escrowTick().catch(console.error), 30000);
  app.listen(PORT, () => console.log("CSELencer API running on port " + PORT));
}).catch((e) => { console.error("MongoDB connection failed:", e.message); process.exit(1); });
