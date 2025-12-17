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
    const decoratorRequestCollection = db.collection("decoratorRequests");

    //user management 
    app.get('/userManage',verifyJWT,async(req,res)=>{
      const result=await userCollection.find().toArray();
      res.send(result)
    })

    // User → Become Decorator Request
    app.post("/decorator-requests", async (req, res) => {
      try {
        const { name, email, division, district, phone, role } = req.body;

        if (!name || !email || !division || !district || !phone) {
          return res.status(400).send({ message: "All fields are required" });
        }

        // Prevent duplicate request
        const alreadyRequested = await decoratorRequestCollection.findOne({
          email,
          status: { $in: ["pending", "approved"] },
        });

        if (alreadyRequested) {
          return res.status(409).send({
            success: false,
            message: "You have already requested or are already a decorator",
          });
        }

        const requestData = {
          name,
          email,
          division,
          district,
          phone,
          role,
          status: "pending",
          requestedAt: new Date(),
        };

        const result = await decoratorRequestCollection.insertOne(requestData);

        res.send({
          success: true,
          message: "Decorator request submitted successfully",
          insertedId: result.insertedId,
        });
      } catch (error) {
        console.error("Decorator Request Error:", error);
        res.status(500).send({ message: "Server error" });
      }
    });

    //decorator request show on admin
    app.get("/decorator-requests", async (req, res) => {
      const result = await decoratorRequestCollection.find().toArray();
      res.send(result);
    });

    app.post("/userBooks", async (req, res) => {
      try {
        const bookingData = req.body;

        const { decorationId, bookingDate, startTime, endTime, userInfo } =
          bookingData;

        if (
          !userInfo?.userEmail ||
          !decorationId ||
          !bookingDate ||
          !startTime ||
          !endTime
        ) {
          return res.status(400).send({ message: "Invalid booking data" });
        }

        // Check duplicate booking
        const duplicateQuery = {
          "userInfo.userEmail": userInfo.userEmail,
          decorationId,
          bookingDate,
          startTime,
          endTime,
        };

        const alreadyBooked = await userBooksCollection.findOne(duplicateQuery);

        if (alreadyBooked) {
          return res.status(409).send({
            success: false,
            message:
              "You have already booked this decoration for the selected date and time",
          });
        }

        bookingData.status = "pending";
        bookingData.paymentStatus = "paid";
        bookingData.assignedDecorator = null;
        bookingData.bookedAt = new Date();

        const result = await userBooksCollection.insertOne(bookingData);

        res.send({
          success: true,
          message: "Booking successful",
          insertedId: result.insertedId,
        });
      } catch (error) {
        console.error("Booking Error:", error);
        res.status(500).send({ message: "Server error" });
      }
    });

    // APPROVE DECORATOR
    app.patch("/decorator-requests/approve/:id", async (req, res) => {
      const id = req.params.id;

      // 1️⃣ Update decorator request status
      const result = await decoratorRequestCollection.updateOne(
        { _id: new ObjectId(id) },
        {
          $set: {
            status: "approved",
            approvedAt: new Date(),
          },
        }
      );

      // 2️⃣ Find request data (email)
      const request = await decoratorRequestCollection.findOne({
        _id: new ObjectId(id),
      });

      // 3️⃣ Update user role → decorator
      if (request?.email) {
        await userCollection.updateOne(
          { email: request.email },
          {
            $set: {
              role: "decorator",
            },
          }
        );
      }

      res.send({
        success: true,
        message: "Decorator approved successfully",
        result,
      });
    });

    //reject decorator
    // REJECT DECORATOR
    app.patch("/decorator-requests/reject/:id", async (req, res) => {
      const id = req.params.id;

      const result = await decoratorRequestCollection.updateOne(
        { _id: new ObjectId(id) },
        {
          $set: {
            status: "rejected",
            rejectedAt: new Date(),
          },
        }
      );

      res.send({
        success: true,
        message: "Decorator request rejected",
        result,
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
          .find({ role: "decoretdeor" })
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
