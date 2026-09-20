const mongoose = require('mongoose');
require('dotenv').config();

mongoose.connect(process.env.MONGODB_URI).then(async () => {
  const Movie = require('./models/Movie');
  
  const gulabi = await Movie.findOne({ title: 'Gulabi' });
  const gulaabi = await Movie.findOne({ title: 'Gulaabi' });

  if (gulabi && gulaabi) {
    console.log("Merging Gulaabi into Gulabi...");
    
    // Merge downloads
    for (const dl of gulaabi.downloads) {
      dl.language = 'Telugu'; // Force it
      gulabi.downloads.push(dl);
    }
    await gulabi.save();
    
    // Delete duplicate
    await Movie.deleteOne({ _id: gulaabi._id });
    console.log("Merge complete!");
  }
  process.exit(0);
});
