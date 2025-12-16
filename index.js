require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const admin = require("firebase-admin");
const port = process.env.PORT || 3000;
const decoded = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString(
  "utf-8"
);
const serviceAccount = JSON.parse(decoded);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const app = express();
// middleware
app.use(
  cors({
    origin: [
      "http://localhost:5173",
      "http://localhost:5174",
      "https://b12-m11-session.web.app",
    ],
    credentials: true,
    optionSuccessStatus: 200,
  })
);
app.use(express.json());

// jwt middlewares
const verifyJWT = async (req, res, next) => {
  const token = req?.headers?.authorization?.split(" ")[1];
  console.log(token);
  if (!token) return res.status(401).send({ message: "Unauthorized Access!" });
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.tokenEmail = decoded.email;
    console.log(decoded);
    next();
  } catch (err) {
    console.log(err);
    return res.status(401).send({ message: "Unauthorized Access!", err });
  }
};

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(process.env.MONGODB_URI, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});
async function run() {
  try {
    const db = client.db("decorationDB");
    const decorationCollection = db.collection("decorations");
    const userCollection = db.collection("users");
    const userBooksCollection = db.collection("userBooks");

    // Save booking
    app.post("/userBooks", async (req, res) => {
      const bookingData = req.body;

      if (!bookingData?.userInfo?.userEmail || !bookingData?.decorationId) {
        return res.status(400).send({ message: "Invalid booking data" });
      }

      const query = {
        "userInfo.userEmail": bookingData.userInfo.userEmail,
        decorationId: bookingData.decorationId,
      };

      const alreadyBooked = await userBooksCollection.findOne(query);

      if (alreadyBooked) {
        return res.status(409).send({
          message: "Already booked this decoration",
        });
      }

      bookingData.bookedAt = new Date();

      const result = await userBooksCollection.insertOne(bookingData);

      res.send({
        success: true,
        message: "Booking successful",
        insertedId: result.insertedId,
      });
    });

    //Post a decoration from admin
    app.post("/decorations", async (req, res) => {
      const decorationData = req.body;
      console.log(decorationData);
      const result = await decorationCollection.insertOne(decorationData);
      res.send(result);
    });

    //get all decoration from db
    app.get("/decorations", async (req, res) => {
      const result = await decorationCollection.find().toArray();
      res.send(result);
    });
    //get a decoration from db
    app.get("/decorations/:id", async (req, res) => {
      const id = req.params.id;
      const result = await decorationCollection.findOne({
        _id: new ObjectId(id),
      });
      res.send(result);
    });

    // User get PurchaseModal - only decorators
    app.get("/Deco_Available", async (req, res) => {
      try {
        const result = await userCollection
          .find({ role: "decoretor" })
          .toArray();
        res.send(result);
      } catch (error) {
        console.error(error);
        res.status(500).send({ message: "Server Error" });
      }
    });

    //save or update ueser in db
    app.post("/user", async (req, res) => {
      const userData = req.body;
      userData.last_loggedIn = new Date().toISOString();

      const query = {
        email: userData.email,
      };

      const alreadyExist = await userCollection.findOne(query);

      if (alreadyExist) {
        const result = await userCollection.updateOne(query, {
          $set: {
            last_loggedIn: new Date().toISOString(),
          },
        });
        return res.send(result);
      }

      const result = await userCollection.insertOne(userData);
      res.send(result);
    });

    //get user role
    app.get("/user/role", verifyJWT, async (req, res) => {
      const result = await userCollection.findOne({ email: req.tokenEmail });
      res.send({ role: result?.role });
    });

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // Ensures that the client will close when you finish/error
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Hello from Server..");
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
