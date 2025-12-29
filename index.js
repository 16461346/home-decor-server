require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
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
    origin: [process.env.DOMAIN_URL],
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
    const BookingCollection = db.collection("userBooking");
    const decoratorRequestCollection = db.collection("decoratorRequests");

    const verifyAdmin = async (req, res, next) => {
      const email = req.tokenEmail; // Correct
      const user = await userCollection.findOne({ email });

      if (!user || user.role !== "admin") {
        return res.status(403).send({ message: "Forbidden access" });
      }

      next();
    };

    //Booking Collection get
    app.get("/bookings", verifyJWT, verifyAdmin, async (req, res) => {
      try {
        const result = await BookingCollection.find({
          status: "pending",
        }).toArray();
        res.send(result);
      } catch (error) {
        console.error("Decorations Error:", error);
        res.status(500).send({ message: "Server error", error });
      }
    });

    app.put("/decoration/:id", async (req, res) => {
      const { id } = req.params;
      const { name, category, description, price } = req.body;

      try {
        const updateData = {
          name,
          category,
          description,
          price: parseFloat(price),
        };

        const result = await decorationCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: updateData }
        );

        if (result.modifiedCount === 1) {
          res.send({ message: "Decoration updated successfully" });
        } else {
          res.status(404).send({ message: "Decoration not found" });
        }
      } catch (error) {
        console.error("Update Decoration Error:", error);
        res.status(500).send({ message: "Server error" });
      }
    });

    app.delete("/decorations/:id", async (req, res) => {
      const { id } = req.params;
      console.log("Deleting ID:", id);
      try {
        const result = await decorationCollection.deleteOne({
          _id: new ObjectId(id),
        });
        console.log(result);
        if (result.deletedCount === 1) {
          res.status(200).send({ message: "Deleted successfully" });
        } else {
          res.status(404).send({ message: "Not found" });
        }
      } catch (error) {
        console.error(error);
        res.status(500).send({ message: "Server error" });
      }
    });

    // My inventory get - admin only
    app.get("/decorations", async (req, res) => {
      try {
        const result = await decorationCollection.find().toArray();
        res.send(result);
      } catch (error) {
        console.error("Decorations Error:", error);
        res.status(500).send({ message: "Server error", error });
      }
    });

    app.patch(
      "/users/update-role",
      verifyJWT,
      verifyAdmin,
      async (req, res) => {
        try {
          const { email, role } = req.body;

          if (!email || !role) {
            return res
              .status(400)
              .send({ message: "Email and role are required" });
          }

          let updateDoc = { $set: { role } };

          if (role === "decorator") {
            // decorator হলে work_Status add/set করো
            updateDoc.$set.work_Status = "available";
          } else {
            // decorator না হলে work_Status remove করো
            updateDoc.$unset = { work_Status: "" };
          }

          const result = await userCollection.updateOne({ email }, updateDoc);

          // response handle
          if (result.acknowledged && result.matchedCount === 0) {
            return res.send({ success: false, message: "User not found" });
          }

          if (result.matchedCount > 0 && result.modifiedCount === 0) {
            return res.send({
              success: true,
              message: "User role already up-to-date",
            });
          }

          res.send({
            success: true,
            message: "User role updated successfully",
          });
        } catch (error) {
          console.error(error);
          res
            .status(500)
            .send({ success: false, message: "Server error", error });
        }
      }
    );

    // Decorations Pending Task → Assigned to decorator
    app.get("/assigned-task", verifyJWT, async (req, res) => {
  try {
    const { decoratorEmail, status } = req.query;

    const query = {
      "assignedDecorator.email": decoratorEmail,
      status: status, // "assigned"
    };

    const tasks = await BookingCollection.find(query).toArray();
    res.send(tasks);
  } catch (error) {
    res.status(500).send({ message: "Server error" });
  }
});


    // Update booking/decorator status
    app.patch("/bookings/:id/status", verifyJWT, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  const result = await BookingCollection.updateOne(
    { _id: new ObjectId(id) },
    { $set: { status, updatedAt: new Date() } }
  );

  res.send({ success: result.modifiedCount > 0 });
});


    // user management
    app.get("/userManage", verifyJWT, async (req, res) => {
      const result = await userCollection.find().toArray();
      res.send(result);
    });

    // ASSIGN DECORATOR TO BOOKING
    app.patch(
      "/bookings/assign-decorator",
      verifyJWT,
      verifyAdmin,
      async (req, res) => {
        try {
          const { bookingId, decoratorId } = req.body;

          if (!bookingId || !decoratorId) {
            return res.status(400).send({ message: "Missing data" });
          }

          // 1️⃣ Find decorator
          const decorator = await userCollection.findOne({
            _id: new ObjectId(decoratorId),
          });

          if (!decorator) {
            return res.status(404).send({ message: "Decorator not found" });
          }

          // 2️⃣ Update booking
          await BookingCollection.updateOne(
            { _id: new ObjectId(bookingId) },
            {
              $set: {
                assignedDecorator: {
                  id: decorator._id,
                  name: decorator.name,
                  email: decorator.email,
                  phone: decorator.phone,
                },
                status: "Decorator-assigned",
                assignedAt: new Date(),
              },
            }
          );

          // 3️⃣ Update decorator work status
          await userCollection.updateOne(
            { _id: new ObjectId(decoratorId) },
            {
              $set: {
                work_Status: "busy",
              },
            }
          );

          res.send({
            success: true,
            message: "Decorator assigned successfully",
          });
        } catch (error) {
          console.error("Assign Decorator Error:", error);
          res.status(500).send({ message: "Server error" });
        }
      }
    );

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

    // APPROVE DECORATOR
    app.patch("/decorator-requests/approve/:id", async (req, res) => {
      try {
        const id = req.params.id;

        // 1️⃣ Find request data FIRST
        const request = await decoratorRequestCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!request) {
          return res.status(404).send({ message: "Request not found" });
        }

        // 2️⃣ Update decorator request status
        await decoratorRequestCollection.updateOne(
          { _id: new ObjectId(id) },
          {
            $set: {
              status: "approved",
              work_Status: "available",
              approvedAt: new Date(),
            },
          }
        );

        // 3️⃣ Update user full data
        const updateResult = await userCollection.updateOne(
          { email: request.email },
          {
            $set: {
              work_Status: "available",
              role: "decorator",
              phone: request.phone,
              division: request.division,
              district: request.district,
              updatedAt: new Date(),
            },
          }
        );

        res.send({
          success: true,
          message: "Decorator approved & user updated successfully",
          updateResult,
        });
      } catch (error) {
        console.error("Approve Decorator Error:", error);
        res.status(500).send({ message: "Server error" });
      }
    });

    // REJECT DECORATOR
    app.patch(
      "/decorator-requests/reject/:id",
      verifyJWT,
      verifyAdmin,
      async (req, res) => {
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
      }
    );

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

    //Payment methode
    app.post("/create-checkout-session", async (req, res) => {
      const paymentInfo = req.body;
      console.log(paymentInfo);
      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            price_data: {
              currency: "usd",
              product_data: {
                name: paymentInfo?.name,
                description: paymentInfo?.description,
                images: [paymentInfo?.image],
              },
              unit_amount: paymentInfo?.price * 100,
            },
            quantity: 1,
          },
        ],
        customer_email: paymentInfo.customer.email,
        mode: "payment",
        metadata: {
          decorationId: paymentInfo.decorationId,
          customer: paymentInfo.customer.email,
          bookingDate: paymentInfo.bookingDate,
          startTime: paymentInfo.startTime,
          endTime: paymentInfo.endTime,
          phone: paymentInfo.phone,
          division: paymentInfo.division,
          district: paymentInfo.district,
          creatorEmail: paymentInfo.creatorEmail,
          creatorName: paymentInfo.creatorName,
          creatorPhoto: paymentInfo.creatorPhoto,
          image: paymentInfo.image,
        },

        success_url: `${process.env.DOMAIN_URL}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.DOMAIN_URL}/service/${paymentInfo?.decorationId}`,
      });
      res.send({
        url: session.url,
      });
    });

    app.post("/payment-success", async (req, res) => {
      const { sessionId } = req.body;

      if (!sessionId) {
        return res.status(400).send({ message: "Session ID missing" });
      }
      try {
        const session = await stripe.checkout.sessions.retrieve(sessionId);
        const decoration = await decorationCollection.findOne({
          _id: new ObjectId(session.metadata.decorationId),
        });

        const order = await BookingCollection.findOne({
          transactionId: session.payment_intent,
        });

        if (session.status === "complete" && decoration && !order) {
          const orderInfo = {
            decorationId: session.metadata.decorationId,
            transactionId: session.payment_intent,
            customer: session.metadata.customer,
            status: "pending",
            payment_status: session.payment_status,
            name: decoration.name,
            category: decoration.category,
            price: session.amount_total / 100,

            // User-provided info
            bookingDate: session.metadata.bookingDate,
            startTime: session.metadata.startTime,
            endTime: session.metadata.endTime,
            phone: session.metadata.phone,
            division: session.metadata.division,
            district: session.metadata.district,
            Image: session.metadata.image,
            created_at: new Date(),
          };

          const result = await BookingCollection.insertOne(orderInfo);
        }
        res.send({ success: true });
      } catch (err) {
        console.error("Stripe retrieve error:", err);
        res
          .status(500)
          .send({ message: "Stripe retrieve failed", error: err.message });
      }
    });

    //get a decoration from db
    app.get("/decorations/:id", async (req, res) => {
      const id = req.params.id;
      const result = await decorationCollection.findOne({
        _id: new ObjectId(id),
      });
      res.send(result);
    });

    app.get("/decorators/available", verifyJWT, async (req, res) => {
      const { division, district, bookingDate } = req.query;
      if (!division || !district || !bookingDate)
        return res.send({ available: false, decorators: [] });

      const decorators = await userCollection
        .find({
          role: "decorator",
          division,
          district,
        })
        .toArray();

      const availableDecorators = decorators.filter((dec) => {
        // যদি decorator এর working_date, start_time, end_time থাকে
        if (!dec.working_date || !dec.start_time || !dec.end_time) return true;
        return (
          new Date(dec.working_date).toISOString().split("T")[0] === bookingDate
        );
      });

      res.send({
        available: availableDecorators.length > 0,
        decorators: availableDecorators,
      });
    });

    // cancel booking by transactionId
    app.patch(
      "/bookings/cancel/:transactionId",
      verifyJWT,
      async (req, res) => {
        const { transactionId } = req.params;

        try {
          const result = await BookingCollection.updateOne(
            { transactionId },
            {
              $set: {
                status: "cancelled",
                cancelledAt: new Date(),
              },
            }
          );

          if (result.matchedCount === 0) {
            return res.status(404).send({
              success: false,
              message: "Booking not found",
            });
          }

          res.send({
            success: true,
            message: "Booking cancelled successfully",
          });
        } catch (error) {
          res.status(500).send({
            success: false,
            message: "Failed to cancel booking",
            error: error.message,
          });
        }
      }
    );

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

    app.get("/my-bookins", verifyJWT, async (req, res) => {
      try {
        const result = await BookingCollection.find({
          customer: req.tokenEmail,
        })
          .sort({ created_at: -1 })
          .toArray();
        res.send(result);
      } catch (err) {
        console.error(err);
        res.status(500).send({ message: "Failed to fetch bookings" });
      }
    });
 
    app.get("/manage-booking", verifyJWT, async (req, res) => {
  try {
    const decoratorEmail = req.tokenEmail; // লগইন করা ডেকোরেটরের email

    const result = await BookingCollection.find({
      "assignedDecorator.email": decoratorEmail, // শুধু যাদের assignedDecorator.email মিলছে
    })
      .sort({ created_at: -1 })
      .toArray();

    res.send(result);
  } catch (err) {
    console.error(err);
    res.status(500).send({ message: "Failed to fetch decorator bookings" });
  }
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
