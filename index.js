'use strict';

const async = require('async');
const AWS = require('aws-sdk');
const util = require('util');
const gm = require('gm')
            .subClass({ imageMagick: true }); // Enable ImageMagick integration.

const AWS_ACL = 'public-read';

const IMAGE_SIZES = [
  { 
    name: 'large',
    width: 640,
    height: 640,
    crop: false
  },
  {
    name: 'large_square',
    width: 640,
    height: 640,
    crop: true
  },
  {
    name: 'medium',
    width: 320,
    height: 320,
    crop: false
  },
  {
    name: 'medium_square',
    width: 320,
    height: 320,
    crop: true
  },
  {
    name: 'thumb',
    width: 120,
    height: 120,
    crop: false
  },
  {
    name: 'thumb_square',
    width: 120,
    height: 120,
    crop: true
  }
];

// get reference to S3 client 
const s3 = new AWS.S3();

exports.handler = function(event, context, callback) {

  // Loop through each file size to create new images
  async.each(IMAGE_SIZES, (imageSize, callback) => {
    
    console.log(`Creating image for ${imageSize.name}`);

    // Read options from the event.
    console.log("Reading options from event:\n", util.inspect(event, {depth: 5}));
    let srcBucket = event.Records[0].s3.bucket.name;
    srcBucket = srcBucket.split('/')[0]; // Get only bucket name

    // Object key may have spaces or unicode non-ASCII characters.
    let srcKey    = decodeURIComponent(event.Records[0].s3.object.key.replace(/\+/g, " "));  
    let dstBucket = srcBucket;
    let dstKey    = imageSize.name + '/' + srcKey.split('/').reverse()[1] + '/' + srcKey.split('/').reverse()[0]; // Get file name from /original/<randomString>/DarthVader.jpg

    console.log("Source bucket: " + srcBucket);
    console.log("Destination bucket: " + dstBucket);
    console.log("Destination Key: " + dstKey);
    console.log("Source Key: " + srcKey);

    // Sanity check: validate that source and destination are different buckets.
    if (dstKey === srcKey) {
      callback("Source and destination buckets are the same.");
      return;
    }

    // Infer the image type.
    let typeMatch = srcKey.match(/\.([^.]*)$/);
    if (!typeMatch) {
      callback("Could not determine the image type.");
      return;
    }

    // Return if this is not an image that can be resized
    let imageType = typeMatch[1];
    if (imageType != "jpg" && imageType != "jpeg" && imageType != "png") {
      console.log(`${imageType} is not a resizeable image type. Nothing to do here.`);
      callback(null, `${imageType} is not a resizeable image type. Nothing to do here.`);
      return;
    }

    // Download the image from S3, transform, and upload to a different S3 bucket.
    async.waterfall([
      function download(next) {
        // Download the image from S3 into a buffer.
        s3.getObject({
          Bucket: srcBucket,
          Key: srcKey
        }, next);
      },
      function transform(response, next) {
        gm(response.Body).size(function(err, size) {

          let cropHeight = size.height;
          let cropWidth = size.width;
          let xCrop = 0;
          let yCrop = 0;
        
          // Crop image
          if (imageSize.crop) {
            // If width equals width x should change from height
            // If height equals height y should change from width
            if (size.width > size.height) {
              // Landscape, change x
              
              // Crop height and width should equal smallest length
              cropHeight = size.height;
              cropWidth = size.height;

              xCrop = (size.width - size.height) / 2;
              yCrop = 0;

              console.log(`Cropped image with cropHeight: ${cropHeight}, cropWidth: ${cropWidth}, xCrop: ${xCrop}, yCrop: ${yCrop}`);

            } else {
              // Portrait, change y
              
              // Crop height and width should equal smallest length
              cropHeight = size.width;
              cropWidth = size.width;

              xCrop = 0;
              yCrop = (size.height - size.width) / 2;

              console.log(`Cropped image with cropHeight: ${cropHeight}, cropWidth: ${cropWidth}, xCrop: ${xCrop}, yCrop: ${yCrop}`);
            }
          }

          // Infer the scaling factor to avoid stretching the image unnaturally.
          var scalingFactor = Math.min(
            imageSize.width / size.width,
            imageSize.height / size.height
          );
          var width  = scalingFactor * size.width;
          var height = scalingFactor * size.height;

          // Transform the image buffer in memory.
          this.crop(cropWidth, cropHeight, xCrop, yCrop)
          .resize(width, height)
          .toBuffer(imageType, function(err, buffer) {
            if (err) {
              next(err);
            } else {
              next(null, response.ContentType, buffer);
            }
          });
        });
      },
      function upload(contentType, data, next) {
        // Stream the transformed image to a different S3 bucket.
        s3.putObject({
          Bucket: dstBucket,
          Key: dstKey,
          Body: data,
          ContentType: contentType,
          ACL: AWS_ACL
        }, next);
      }
    ], function (err) {
      if (err) {
        console.error(
          'Unable to resize ' + srcBucket + '/' + srcKey +
          ' and upload to ' + dstBucket + '/' + dstKey +
          ' due to an error: ' + err
          );
        callback(err);
        return;
      } else {
        console.log(
          'Successfully resized ' + srcBucket + '/' + srcKey +
          ' and uploaded to ' + dstBucket + '/' + dstKey
          );
        callback(null, "Success");
        return;
      }
    });

  }, function(err){
    // if any of the file processing produced an error, err would equal that error
    if (err) {
      // One of the iterations produced an error.
      // All processing will now stop.
      console.error('Unable to resize image due to an error: ' + err);
    } else {
      callback(null, 'All files have been processed successfully');
    }
  });
};
